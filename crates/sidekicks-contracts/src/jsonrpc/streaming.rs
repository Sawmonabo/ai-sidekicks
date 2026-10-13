//! The wire shapes of a streaming subscription: the acknowledgement every `*.subscribe` method
//! answers with, the `$/subscription/notify` frame carrying one value, the `$/subscription/end`
//! frame the daemon ends a stream with, and the `$/subscription/cancel` call a client tears one
//! down with. A subscription holds only its place, never a queue, so a frame carries changes and
//! nothing is ever dropped from it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::message::JsonRpcError;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::AnyValue;

ts_constants! {
    /// The daemon-to-client notification carrying one subscription value. The `$/` prefix marks a
    /// system method outside the user namespace; the daemon registers no handler for it.
    pub const SUBSCRIPTION_NOTIFY_METHOD: &str = "$/subscription/notify";
    /// The call a client sends to tear down a subscription. The daemon answers it as a read, so a
    /// client can still clean up after a failed version handshake.
    pub const SUBSCRIPTION_CANCEL_METHOD: &str = "$/subscription/cancel";
    /// The daemon-to-client notification that ends one subscription from the daemon's side: the
    /// last frame for that id. A subscription the client cancels, or whose connection closes,
    /// gets none.
    pub const SUBSCRIPTION_END_METHOD: &str = "$/subscription/end";
    /// The most changes one frame carries. The daemon coalesces a stream's changes into one frame
    /// per short window or this many changes, whichever comes first.
    pub const STREAM_FRAME_MAX_CHANGES: usize = 50;
}

branded_uuid_id! {
    /// The opaque id of one subscription, a UUID the daemon mints.
    SubscriptionId
}

/// The params of an end frame: `completed` when the stream finished, or `refused` with the error
/// the daemon ended it for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "reason",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SubscriptionEndParams {
    /// The stream finished.
    Completed {
        /// The subscription that ended.
        subscription_id: SubscriptionId,
    },
    /// The daemon ended the stream for an error.
    Refused {
        /// The subscription that ended.
        subscription_id: SubscriptionId,
        /// Why it ended.
        error: JsonRpcError,
    },
}

/// The acknowledgement every `*.subscribe` method answers with: the id the daemon allocated.
/// Values follow as notify frames, and the acknowledgement settles before any of them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribeAckResponse {
    /// The subscription's id, which routes its notify frames.
    pub subscription_id: SubscriptionId,
}

/// The params of a notify frame: the id that routes it and one value the stream produced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SubscriptionNotifyParams")]
pub struct SubscriptionNotifyParams<T> {
    /// The subscription the value belongs to.
    pub subscription_id: SubscriptionId,
    /// The value.
    pub value: T,
}

/// Declares one stream's frame: the changes since the previous frame, oldest first, at least one
/// and at most [`STREAM_FRAME_MAX_CHANGES`], each carrying its own cursor.
///
/// ```ignore
/// stream_frame! {
///     /// One `run.queueSubscribe` emission.
///     pub struct RunQueueStreamFrame(RunQueueChange);
/// }
/// ```
#[expect(
    unused_macros,
    reason = "the run queue, run state and session streams declare their frames with it"
)]
macro_rules! stream_frame {
    ($($(#[doc = $doc:literal])+ pub struct $name:ident($change:ty);)+) => {$(
        $(#[doc = $doc])+
        #[derive(
            Clone,
            Debug,
            PartialEq,
            serde::Serialize,
            serde::Deserialize,
            schemars::JsonSchema,
        )]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// The changes, oldest first.
            pub changes: $crate::wire::list::BoundedVec<
                $change,
                1,
                { $crate::jsonrpc::streaming::STREAM_FRAME_MAX_CHANGES },
            >,
        }
    )+};
}

#[expect(
    unused_imports,
    reason = "the run queue, run state and session streams declare their frames with it"
)]
pub(crate) use stream_frame;

/// The params of a cancel call. It is a request, so the client learns from its result whether it
/// worked; only the connection that owns a subscription can cancel it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionCancelParams {
    /// The subscription to cancel.
    pub subscription_id: SubscriptionId,
}

/// The result of a cancel call. `canceled` is false when the id is unknown or another
/// connection's; the two are not told apart, so one connection cannot probe for another's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionCancelResult {
    /// Whether the subscription was canceled.
    pub canceled: bool,
}

/// The TypeScript module of the subscription wire.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/streaming",
    doc: "The wire shapes of a streaming subscription: `$/subscription/notify`, \
          `$/subscription/end` and `$/subscription/cancel`, and the acknowledgement every \
          `*.subscribe` method answers with. A subscription holds only its place, never a queue, \
          so nothing is dropped from its frames.",
    definitions: &[
        Definition::read::<SubscriptionId>().checked(),
        Definition::read::<SubscriptionEndParams>().checked(),
        Definition::read::<SubscribeAckResponse>().checked(),
        Definition::read::<SubscriptionNotifyParams<AnyValue>>().checked(),
        Definition::read::<SubscriptionCancelParams>(),
        Definition::read::<SubscriptionCancelResult>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
