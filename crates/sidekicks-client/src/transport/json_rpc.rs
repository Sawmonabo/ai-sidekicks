//! The typed JSON-RPC client: typed and untyped calls and subscriptions over the link it holds,
//! each registered when it is made, so calls go out in the order they were made. Calls past the
//! call cap, or made while no link is open, wait in order; a keyed call a dropped link left in
//! flight is sent once more on the next link, and settles if that one drops too.

pub(crate) mod calls;

use std::future::Future;
use std::sync::Arc;

use bytes::Bytes;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::negotiation::{
    CONNECTION_INITIALIZE_METHOD, ConnectionInitializeRequest, ConnectionInitializeResponse,
    DaemonHandshake,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::{Method, MethodDescriptor, SubscriptionMethod};
use sidekicks_contracts::wire::attachment;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use self::calls::{Answer, CallKey, ClientShared};
use super::link::{self, Link, LinkShared};
use super::subscription::{Subscription, read_raw_value, read_typed_value};
use crate::error::{ClientError, LinkFault, RemoteError, ReplyError, RequestError};

/// A request as sent: the method's contract, its params' JSON, and the params' attachments.
#[derive(Clone, Debug)]
pub struct RawRequest {
    /// The method's contract: its wire name, whether it is keyed and whether it takes a slot.
    pub descriptor: &'static MethodDescriptor,
    /// The params' JSON, absent for a method that takes none.
    pub params: Option<Box<RawValue>>,
    /// The params' attachments, in the order their placeholders index them.
    pub attachments: Vec<Bytes>,
}

/// An answer's JSON (a result, an acknowledgment or a stream value) with its attachments.
#[derive(Debug)]
pub struct RawReply {
    /// The JSON as the daemon sent it.
    pub json: Box<RawValue>,
    /// The message's attachments.
    pub attachments: Vec<Bytes>,
}

/// The daemon's answer to `connection.initialize` on a link [`JsonRpcClient::open_link`] opened.
#[derive(Debug)]
pub enum HandshakeAnswer {
    /// The handshake's answer; the link is the client's.
    Initialized(ConnectionInitializeResponse),
    /// The `daemon.repairing` refusal: the daemon repairs its database file and serves only the
    /// lifecycle verbs on this link, which is open but not yet the client's.
    Repairing(RemoteError),
}

/// The typed JSON-RPC client; cheap to clone, every clone the same client. Calls made while no
/// link is open wait, in order, for the next link or for `abandon`; once every handle and `Link`
/// is dropped the open link ends and its socket closes.
#[derive(Clone, Default)]
pub struct JsonRpcClient {
    shared: Arc<ClientShared>,
}

impl JsonRpcClient {
    /// A client with no link yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The handle over `shared`.
    pub(crate) fn from_shared(shared: Arc<ClientShared>) -> Self {
        Self { shared }
    }

    /// Opens a link over `stream`: sends `connection.initialize` first (no envelope
    /// `protocolVersion`) and reads its answer; a successful answer, `compatible: false` among
    /// them, makes the link the client's, the keyed calls a dropped link left are sent again under
    /// new ids in their order, then the held calls go out up to the cap. A `daemon.repairing`
    /// refusal keeps the link open but not the client's, so no held call goes out on a link that
    /// serves only the lifecycle verbs; the caller installs it with [`Self::install`] or closes
    /// it. Any other error answer, a reply that does not read, or the link ending first closes it
    /// and fails with that error.
    pub async fn open_link<S>(
        &self,
        stream: S,
        initialize: &ConnectionInitializeRequest,
    ) -> Result<(HandshakeAnswer, Link), ClientError>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let link = link::start(
            Arc::downgrade(&self.shared),
            self.shared.next_generation(),
            stream,
        );
        let mut opening = OpeningLink {
            client: &self.shared,
            link: &link,
            is_open: false,
        };
        let answer = self.issue(
            typed_request::<DaemonHandshake>(initialize),
            Answer::Call,
            None,
            Some(&link),
        );
        let answer = match answer.await {
            Ok(reply) => HandshakeAnswer::Initialized(read_reply::<ConnectionInitializeResponse>(
                CONNECTION_INITIALIZE_METHOD,
                reply,
            )?),
            Err(ClientError::Remote(refusal))
                if refusal.is_refusal(RefusalCode::DaemonRepairing) =>
            {
                HandshakeAnswer::Repairing(refusal)
            }
            Err(error) => return Err(error),
        };
        if let HandshakeAnswer::Initialized(_) = answer {
            self.shared.install(&link)?;
        }
        opening.is_open = true;
        Ok((
            answer,
            Link::new(Arc::clone(&link), Arc::clone(&self.shared)),
        ))
    }

    /// Makes `link`, opened on this client with a `daemon.repairing` answer, the client's, so
    /// calls go out on it; fails with the link's fault where it ended meanwhile.
    pub(crate) fn install(&self, link: &Link) -> Result<(), ClientError> {
        self.shared.install(link.shared())
    }

    /// A typed call, registered now; the params are the caller's own (written with
    /// `wire::attachment::write`), and the reply is read with its attachments and held to its
    /// garde rules. Fails as the daemon refused it, as `ClientError::Reply` when the reply does
    /// not read, or as `ClientError::Request` when the params cannot be written.
    pub fn call<M>(
        &self,
        params: &M::Params,
    ) -> impl Future<Output = Result<M::Result, ClientError>> + Send + 'static + use<M>
    where
        M: Method + 'static,
    {
        let answer = self.issue(typed_request::<M>(params), Answer::Call, None, None);
        async move { read_reply::<M::Result>(M::DESCRIPTOR.method, answer.await?) }
    }

    /// `call`, canceled by `cancel`: a held call settles `ClientError::Canceled` and sends
    /// nothing; a call in flight sends `$/cancelRequest` once and settles from the daemon's one
    /// answer.
    pub fn call_until<M>(
        &self,
        params: &M::Params,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<M::Result, ClientError>> + Send + 'static + use<M>
    where
        M: Method + 'static,
    {
        let answer = self.issue(
            typed_request::<M>(params),
            Answer::Call,
            Some(cancel.clone()),
            None,
        );
        async move { read_reply::<M::Result>(M::DESCRIPTOR.method, answer.await?) }
    }

    /// The untyped call, registered now, with `call_until`'s cancel; the reply is passed on
    /// unread.
    pub fn call_raw(
        &self,
        request: RawRequest,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<RawReply, ClientError>> + Send + 'static + use<> {
        self.issue(Ok(request), Answer::Call, Some(cancel.clone()), None)
    }

    /// Opens a subscription, registered now, and answers once its acknowledgment arrives, with
    /// the acknowledgment (read and held to its garde rules) and the stream; an acknowledgment
    /// that does not read cancels the subscription and fails as `ClientError::Reply`.
    pub fn subscribe<M>(
        &self,
        params: &M::Params,
    ) -> impl Future<Output = Result<(M::Result, Subscription<M::Emission>), ClientError>>
    + Send
    + 'static
    + use<M>
    where
        M: SubscriptionMethod + 'static,
    {
        let opening = self.issue(typed_request::<M>(params), Answer::Subscribe, None, None);
        async move {
            let (acknowledgment, subscription) =
                opening.await?.into_stream(read_typed_value::<M::Emission>);
            let acknowledgment = read_reply::<M::Result>(M::DESCRIPTOR.method, acknowledgment)?;
            Ok((acknowledgment, subscription))
        }
    }

    /// The untyped subscribe, registered now: the acknowledgment and each value passed on unread
    /// (a value is the notify's `value` member with the message's attachments).
    pub fn subscribe_raw(
        &self,
        request: RawRequest,
    ) -> impl Future<Output = Result<(RawReply, Subscription<RawReply>), ClientError>>
    + Send
    + 'static
    + use<> {
        let opening = self.issue(Ok(request), Answer::Subscribe, None, None);
        async move { Ok(opening.await?.into_stream(read_raw_value)) }
    }

    /// A typed call sent on `link` alone, past the cap, never held; fails with the link's fault
    /// once it has ended.
    pub(crate) fn call_on<M>(
        &self,
        params: &M::Params,
        link: &Arc<LinkShared>,
    ) -> impl Future<Output = Result<M::Result, ClientError>> + Send + 'static + use<M>
    where
        M: Method + 'static,
    {
        let answer = self.issue(typed_request::<M>(params), Answer::Call, None, Some(link));
        async move { read_reply::<M::Result>(M::DESCRIPTOR.method, answer.await?) }
    }

    /// Takes the client down: every call held or waiting to be sent again settles with
    /// `ClientError::link_down(cause)`, and so does every call made until [`Self::hold_calls`] or
    /// a link opens again.
    pub fn abandon(&self, cause: LinkFault) {
        self.shared.abandon(cause);
    }

    /// After [`Self::abandon`], holds new calls again, in order, for the next link.
    pub fn hold_calls(&self) {
        self.shared.hold_calls();
    }

    /// Closes the open link (`LinkFault::Closed`), takes the client down as `abandon` does, and
    /// answers once the link's socket is closed.
    pub async fn close(&self) {
        let link = self.shared.open_link();
        self.shared.abandon(LinkFault::Closed);
        if let Some(link) = link {
            link.socket_closed().await;
        }
    }

    /// Registers a call now and answers the future that waits for its answer; a request that
    /// could not be built fails in that future.
    fn issue<T>(
        &self,
        request: Result<RawRequest, ClientError>,
        answer: fn(oneshot::Sender<Result<T, ClientError>>) -> Answer,
        cancel: Option<CancellationToken>,
        pinned: Option<&Arc<LinkShared>>,
    ) -> impl Future<Output = Result<T, ClientError>> + Send + 'static + use<T>
    where
        T: Send + 'static,
    {
        let registered = request.map(|request| {
            let (sender, receiver) = oneshot::channel();
            let key = self.shared.register(request, answer(sender), pinned);
            let pending = PendingCall {
                client: Arc::clone(&self.shared),
                key,
            };
            (pending, receiver)
        });
        async move {
            let (pending, receiver) = registered?;
            pending.answer(receiver, cancel).await
        }
    }
}

/// A registered call its caller waits on; dropped while still held, it leaves the client unsent.
struct PendingCall {
    client: Arc<ClientShared>,
    key: CallKey,
}

impl PendingCall {
    /// Waits for the call's answer; a `cancel` that fires withdraws a held call as
    /// `ClientError::Canceled`, or sends a call in flight its `$/cancelRequest` and keeps waiting.
    async fn answer<T>(
        &self,
        mut receiver: oneshot::Receiver<Result<T, ClientError>>,
        cancel: Option<CancellationToken>,
    ) -> Result<T, ClientError> {
        if let Some(cancel) = cancel {
            tokio::select! {
                biased;
                answer = &mut receiver => return received(answer),
                () = cancel.cancelled() => {}
            }
            if self.client.cancel(self.key) {
                return Err(ClientError::Canceled);
            }
        }
        received(receiver.await)
    }
}

impl Drop for PendingCall {
    fn drop(&mut self) {
        self.client.withdraw(self.key);
    }
}

/// A call's answer; a call settled without one was dropped with its client.
fn received<T>(
    answer: Result<Result<T, ClientError>, oneshot::error::RecvError>,
) -> Result<T, ClientError> {
    answer.unwrap_or_else(|_closed| Err(ClientError::link_down(LinkFault::Closed)))
}

/// A link `open_link` is opening; dropped before it opened, it ends the link.
struct OpeningLink<'a> {
    client: &'a ClientShared,
    link: &'a Arc<LinkShared>,
    is_open: bool,
}

impl Drop for OpeningLink<'_> {
    fn drop(&mut self) {
        if !self.is_open {
            self.client.end_link(self.link, LinkFault::Closed);
        }
    }
}

/// `M`'s request for `params`, written with its attachments; fails as `ClientError::Request` where
/// the params' own `Serialize` fails.
pub(crate) fn typed_request<M: Method>(params: &M::Params) -> Result<RawRequest, ClientError> {
    let descriptor = const { &M::DESCRIPTOR };
    let request_error = |source: serde_json::Error| ClientError::Request {
        method: descriptor.method.to_owned(),
        source: RequestError::Json(source),
    };
    let (json, attachments) = attachment::write(params).map_err(request_error)?;
    let json = String::from_utf8(json).expect("serde_json writes UTF-8");
    let params = RawValue::from_string(json).map_err(request_error)?;
    Ok(RawRequest {
        descriptor,
        params: Some(params),
        attachments,
    })
}

/// Reads `method`'s reply as `T` with its attachments, then holds it to `T`'s garde rules; fails
/// as `ClientError::Reply`.
fn read_reply<T>(method: &str, reply: RawReply) -> Result<T, ClientError>
where
    T: DeserializeOwned + garde::Validate<Context = ()>,
{
    let reply_error = |source: ReplyError| ClientError::Reply {
        method: method.to_owned(),
        source,
    };
    let value: T = attachment::parse(reply.json.get().as_bytes(), reply.attachments)
        .map_err(|error| reply_error(error.into()))?;
    value
        .validate()
        .map_err(|report| reply_error(report.into()))?;
    Ok(value)
}
