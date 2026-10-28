//! The message queue: every message the person sends waits here until the agent takes it at its
//! next step. The lead has one queue and each child its own; every queue verb but the send takes
//! `childHandle` to reach a child's queue, whose messages arrive through `agent.childRun.steer`.
//! Also the `agent.queueItem.*` event payloads and the frame `agent.queueItem.subscribe` sends.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{EnumDiscriminants, IntoStaticStr, VariantArray};

use crate::agent::definition::binding::ProviderToken;
use crate::agent::tree::ChildHandle;
use crate::artifacts::attachment_reference::AttachmentReferenceList;
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::stream_frame;
use crate::method::KeyedRequest;
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::question::QuestionId;
use crate::repo::mount::WorkspaceId;
use crate::run::id::RunId;
use crate::session::controls::methods::SessionReviewTarget;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::voice::MessageOrigin;
use crate::wire::id::ClientUuid;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::text::FreeFormText;
use crate::wire::{Never, literal};

branded_uuid_id! {
    /// Identifies one queued message.
    QueueItemId
}

/// Where a queued message stands: waiting, sent to the run, replaced, canceled, or never sent.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum QueueItemState {
    /// Waiting for the agent's next step.
    Queued,
    /// Taken by the run.
    Admitted,
    /// Replaced by an edit or a retry.
    Superseded,
    /// Removed.
    Canceled,
    /// Taken but never delivered.
    NotDelivered,
}

/// Why a taken message was never delivered, tagged on `kind`: it waited past the daemon's own
/// delivery timeout, its delivery failed outright, or the person's own `UserPromptSubmit` hook
/// refused it after the provider was handed it, with the hook's words. Either way it can be sent
/// again.
#[derive(
    Clone,
    Debug,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    JsonSchema,
    garde::Validate,
    EnumDiscriminants,
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
#[strum_discriminants(
    name(QueueItemNotDeliveredKind),
    doc = "Why a taken message was never delivered, spelled as its reason's `kind` tag.",
    derive(Hash, Serialize, Deserialize, IntoStaticStr, VariantArray),
    serde(rename_all = "camelCase"),
    strum(serialize_all = "camelCase")
)]
pub enum QueueItemNotDeliveredReason {
    /// It waited past the delivery timeout.
    TimedOut {},
    /// Its delivery failed.
    Failed {},
    /// The person's own `UserPromptSubmit` hook refused it.
    RefusedByHook {
        /// The hook's own words.
        words: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
}

/// The words of a message the person sends.
pub type MessageContent = FreeFormText<{ usize::MAX }>;

/// One skill a send picked: its front-matter name and its folder, as `skill.list` gives them. A
/// provider that takes a skill as its own input item receives the `SKILL.md` path its own skill
/// list gives for that name in that folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedSkillPick {
    /// The skill's front-matter name.
    pub name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// The skill's folder.
    pub folder_path: FilesystemPath,
}

/// Sends one message to the lead, whether a turn is running or not (`agent.queueItem.create`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentQueueItemCreateRequest {
    /// The session.
    pub session_id: SessionId,
    /// Another session to deliver to instead; the message arrives there as its own row.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub to: Option<SessionId>,
    /// Binds the run a send starts to its repository.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkspaceId")]
    pub workspace_id: Option<WorkspaceId>,
    /// A send again under the same key answers what the first saved. A retry's key is the failed
    /// message's id, so a second press answers as the first did.
    pub client_idempotency_key: ClientUuid,
    /// The words.
    pub content: MessageContent,
    /// The message's files in staging order; one the daemon cannot deliver stays, marked.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AttachmentReferenceList")]
    pub attachments: Option<AttachmentReferenceList>,
    /// Each skill picked from the composer's `/` and `$` list, in the order picked. The daemon
    /// refuses a pick the provider's own skill list, where it keeps one, does not name in that
    /// folder.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<QueuedSkillPick>")]
    pub skills: Option<Vec<QueuedSkillPick>>,
    /// Edits this waiting message in place: it keeps its place and the old item reads
    /// `superseded`. Naming a message not delivered, with its own words, is a retry that queues
    /// its words and files again as a new message at the queue's end.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QueueItemId")]
    pub replaces_queue_item_id: Option<QueueItemId>,
    /// The question this send answers, one the agent does not wait for; the daemon copies it onto
    /// the `user.message.sent` row it writes, which marks the question answered.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QuestionId")]
    pub answers_question_id: Option<QuestionId>,
    /// The output-speed level this send's turn alone runs at, the agent's own level staying as it
    /// is: `Use standard` after a turn failed for want of flex capacity sends the standard level.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub output_speed_for_turn: Option<ProviderToken>,
}

impl KeyedRequest for AgentQueueItemCreateRequest {}

/// The `user.message.sent` payload: the person's message as a transcript row, written when the
/// daemon accepts the send. `origin` marks the words a voice call heard, and `answers_question_id`
/// is the answered mark of the question a message answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserMessageSentPayload {
    /// The session.
    pub session_id: SessionId,
    /// The queued message, where the send went through the queue.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QueueItemId")]
    pub queue_item_id: Option<QueueItemId>,
    /// The run it was sent toward.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// Repeats the envelope's actor.
    pub actor: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The device that sent it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DeviceId")]
    pub device_id: Option<DeviceId>,
    /// The words.
    pub message: MessageContent,
    /// Where the words came from when no one typed them.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "MessageOrigin")]
    pub origin: Option<MessageOrigin>,
    /// The question it answers; absent on every other message.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QuestionId")]
    pub answers_question_id: Option<QuestionId>,
}

literal! {
    /// The state `agent.queueItem.created` records.
    pub enum QueueItemQueuedState = "queued";
    /// The state `agent.queueItem.admitted` records.
    pub enum AgentQueueItemAdmittedState = "admitted";
    /// The state `agent.queueItem.superseded` records.
    pub enum AgentQueueItemSupersededState = "superseded";
    /// The state `agent.queueItem.canceled` records, and a removal answers.
    pub enum AgentQueueItemCanceledState = "canceled";
    /// The state `agent.queueItem.notDelivered` records.
    pub enum AgentQueueItemNotDeliveredState = "notDelivered";
}

/// Declares the payload of one `agent.queueItem.*` event: the item, the state it entered, and the
/// members that state adds. Each refuses another state and the members of another event.
macro_rules! queue_item_event_payload {
    ($($(#[doc = $doc:literal])+ $name:ident($state:ty) { $($members:tt)* })+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// The session.
            pub session_id: SessionId,
            /// The item.
            pub queue_item_id: QueueItemId,
            /// The state the item entered.
            pub state: $state,
            $($members)*
        }
    )+};
}

queue_item_event_payload! {
    /// The `agent.queueItem.created` payload: a message entered the queue. The words stay on
    /// `user.message.sent`.
    AgentQueueItemCreatedPayload(QueueItemQueuedState) {}
    /// The `agent.queueItem.admitted` payload: the run that took the message, which can differ from
    /// the run its `user.message.sent` was sent toward.
    AgentQueueItemAdmittedPayload(AgentQueueItemAdmittedState) {
        /// The run that took it.
        pub run_id: RunId,
    }
    /// The `agent.queueItem.superseded` payload: the item that replaced the message.
    AgentQueueItemSupersededPayload(AgentQueueItemSupersededState) {
        /// The item that replaced it.
        pub replaced_by_queue_item_id: QueueItemId,
    }
    /// The `agent.queueItem.canceled` payload: the message was removed.
    AgentQueueItemCanceledPayload(AgentQueueItemCanceledState) {}
    /// The `agent.queueItem.notDelivered` payload: the message was taken and never delivered, and
    /// why.
    AgentQueueItemNotDeliveredPayload(AgentQueueItemNotDeliveredState) {
        /// Why it was never delivered.
        pub not_delivered_reason: QueueItemNotDeliveredReason,
    }
}

/// Declares a queue item's view as a union on `state`: every arm repeats the given members, and
/// only the `notDelivered` arm carries, and always carries, the daemon's reason.
macro_rules! queue_item_by_state {
    ($(#[$meta:meta])+ $name:ident { $($members:tt)* }) => {
        #[derive(
            Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
        )]
        $(#[$meta])+
        #[serde(
            tag = "state",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {
            /// Waiting for the agent's next step.
            Queued {
                $($members)*
                /// Only a not-delivered item carries a reason.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                not_delivered_reason: Option<Never>,
            },
            /// Taken by the run.
            Admitted {
                $($members)*
                /// Only a not-delivered item carries a reason.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                not_delivered_reason: Option<Never>,
            },
            /// Replaced by an edit or a retry.
            Superseded {
                $($members)*
                /// Only a not-delivered item carries a reason.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                not_delivered_reason: Option<Never>,
            },
            /// Removed.
            Canceled {
                $($members)*
                /// Only a not-delivered item carries a reason.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                not_delivered_reason: Option<Never>,
            },
            /// Taken and never delivered.
            NotDelivered {
                $($members)*
                /// Why it was never delivered.
                not_delivered_reason: QueueItemNotDeliveredReason,
            },
        }
    };
}

queue_item_by_state! {
    /// The queued message, as a send or a child's steer answers, and, when a send again under the
    /// same key answers one whose delivery failed, the daemon's reason.
    AgentQueueItemCreateResponse {
        /// The item.
        queue_item_id: QueueItemId,
        /// When it was queued.
        #[garde(dive)]
        created_at: WireInstant,
    }
}

/// Reads a queue, the lead's or, with `childHandle`, a child's, in the daemon's order
/// (`agent.queueItem.list`): the items in `state` when it is given, else every item waiting or not
/// delivered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentQueueItemListRequest {
    /// The session.
    pub session_id: SessionId,
    /// The child whose queue to read; absent for the lead's.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ChildHandle")]
    pub child_handle: Option<ChildHandle>,
    /// The state to read.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QueueItemState")]
    pub state: Option<QueueItemState>,
}

/// Declares one kind of queue item's view, inlined into `QueueItemSummary`'s arm: a union on
/// `state` whose every arm repeats the members each kind carries, then the kind's own.
macro_rules! queue_item_summary_by_state {
    ($(#[doc = $doc:literal])+ $name:ident { $($members:tt)* }) => {
        queue_item_by_state! {
            $(#[doc = $doc])+
            #[schemars(inline)]
            $name {
                /// The item.
                id: QueueItemId,
                /// Its place in its queue's order, lowest first.
                position: SafeInt<0>,
                $($members)*
                /// Whether `Send now` marked it and no later order moved it off first place.
                is_sent_now: bool,
                /// When it was queued.
                #[garde(dive)]
                created_at: WireInstant,
                /// When it last changed.
                #[garde(dive)]
                updated_at: WireInstant,
            }
        }
    };
}

queue_item_summary_by_state! {
    /// One queued message, as a pending row draws it: its words and files, its place in its
    /// queue's order (lowest first, an edit taking the place of the message it replaced), the
    /// child whose queue holds it (absent on the lead's), and, once its delivery has failed, the
    /// daemon's reason.
    QueueMessageSummary {
        /// The words.
        content: MessageContent,
        /// The message's files in staging order.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "AttachmentReferenceList")]
        attachments: Option<AttachmentReferenceList>,
        /// The child whose queue holds it; absent on the lead's.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ChildHandle")]
        child_handle: Option<ChildHandle>,
    }
}

queue_item_summary_by_state! {
    /// A review of the session's changes waiting on the lead's queue as the session's next item,
    /// as a pending row draws it: what it covers, its place in the queue's order, and, once its
    /// start has failed, the daemon's reason. Its report lands as the agent's reply.
    QueueReviewSummary {
        /// What the review covers.
        target: SessionReviewTarget,
    }
}

/// One queue item as a pending row draws it, tagged on `kind`: a message the person sent, or the
/// provider's own review queued behind the session's running turn; each also tagged on `state`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum QueueItemSummary {
    /// A message.
    Message(#[garde(dive)] QueueMessageSummary),
    /// A review.
    Review(#[garde(dive)] QueueReviewSummary),
}

/// A queue's items in the daemon's order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentQueueItemListResponse {
    /// The items.
    #[garde(dive)]
    pub items: Vec<QueueItemSummary>,
}

/// One change on a queue's stream: the item as it now stands, and the cursor of the
/// `agent.queueItem.*` event that changed it, or, for a reorder, which no event records, the
/// session's newest cursor when the change went out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunQueueStreamChange {
    /// Where the change stands in the session's log.
    #[garde(skip)]
    pub cursor: EventCursor,
    /// The item as it now stands.
    #[garde(dive)]
    pub item: QueueItemSummary,
}

stream_frame! {
    /// One notify of `agent.queueItem.subscribe`: the queue's changes since the previous frame.
    pub struct RunQueueStreamFrame(RunQueueStreamChange);
}

/// Opens a queue's stream, the lead's or, with `childHandle`, a child's
/// (`agent.queueItem.subscribe`). With `after_cursor`, the stream first sends each item that
/// changed after that cursor and every item still waiting, as it now stands, then follows live;
/// without it, it follows from now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentQueueItemSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
    /// The child whose queue to follow; absent for the lead's.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ChildHandle")]
    pub child_handle: Option<ChildHandle>,
    /// The cursor to catch up from.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "EventCursor")]
    pub after_cursor: Option<EventCursor>,
}

/// Removes a waiting message, from the lead's queue or, with `childHandle`, a child's
/// (`agent.queueItem.cancel`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentQueueItemCancelRequest {
    /// The item.
    pub queue_item_id: QueueItemId,
    /// The child whose queue holds it; absent for the lead's.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ChildHandle")]
    pub child_handle: Option<ChildHandle>,
}

/// The canceled message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentQueueItemCancelResponse {
    /// The item.
    pub queue_item_id: QueueItemId,
    /// Always `canceled`.
    pub state: AgentQueueItemCanceledState,
}

/// Puts a queue's waiting messages in a new order (`agent.queueItem.reorder`): the full order,
/// naming each waiting item once. The daemon refuses a list that does not name exactly the items
/// still waiting, and answers the queue in its new order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentQueueItemReorderRequest {
    /// The session.
    #[garde(skip)]
    pub session_id: SessionId,
    /// The child whose queue to reorder; absent for the lead's.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ChildHandle")]
    #[garde(skip)]
    pub child_handle: Option<ChildHandle>,
    /// The new order, each waiting item once.
    #[garde(dive)]
    pub queue_item_ids: UniqueList<QueueItemId, 1, { usize::MAX }>,
}

ts_constants! {
    /// The refusal of a send while the daemon cannot store the queue: nothing is queued, and the
    /// send can be made again once the store is back.
    AGENT_QUEUE_ITEM_PERSISTENCE_UNAVAILABLE_CODE =
        RefusalCode::AgentQueueItemPersistenceUnavailable;
    /// The refusal of a send whose session's lead run started, ended or was continued between
    /// each read and the write that sends into it, every time the daemon tried: nothing is queued.
    AGENT_QUEUE_ITEM_RUN_CHANGED_CODE = RefusalCode::AgentQueueItemRunChanged;
    /// The refusal of a change naming a queue item the queue does not hold: an id it never stored,
    /// an item of another session, or one of another queue than the change names.
    AGENT_QUEUE_ITEM_NOT_FOUND_CODE = RefusalCode::AgentQueueItemNotFound;
    /// The refusal of a change to a waiting message the agent has already taken or the provider
    /// did not give back, a retry in other words than its own, or a reorder whose list is not
    /// exactly the waiting items.
    AGENT_QUEUE_ITEM_CHANGE_REFUSED_CODE = RefusalCode::AgentQueueItemChangeRefused;
}

/// Why a change to a waiting message was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AgentQueueItemChangeRefusedReason {
    /// The agent has already taken the message.
    AlreadyTaken,
    /// The provider did not give the message back, which now reads not delivered.
    NotDelivered,
    /// The reorder's list is not exactly the waiting items.
    OrderMismatch,
}

/// The details an `agent.queueItem.changeRefused` refusal carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentQueueItemChangeRefusedDetails {
    /// Why the change was refused.
    pub reason: AgentQueueItemChangeRefusedReason,
}

/// The details a `session.message.tooLarge` refusal carries: the provider's limit and the
/// message's length, both in characters as that provider counts them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMessageTooLargeDetails {
    /// The most characters the provider takes in one message.
    pub limit: SafeInt<1>,
    /// The characters the refused message held.
    pub observed: SafeInt<1>,
}

/// The TypeScript module of the message queue.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/queue",
    doc: "The message queue: every message the person sends waits here until the agent takes it \
          at its next step. Also the `agent.queueItem.*` event payloads and the \
          frame `agent.queueItem.subscribe` sends.",
    definitions: &[
        Definition::read::<QueueItemId>().checked(),
        Definition::read::<QueueItemState>().checked(),
        Definition::read::<QueueItemNotDeliveredReason>(),
        Definition::read::<QueuedSkillPick>(),
        Definition::read::<AgentQueueItemCreateRequest>().checked(),
        Definition::read::<UserMessageSentPayload>().checked(),
        Definition::read::<AgentQueueItemCreatedPayload>().checked(),
        Definition::read::<AgentQueueItemAdmittedPayload>().checked(),
        Definition::read::<AgentQueueItemSupersededPayload>().checked(),
        Definition::read::<AgentQueueItemCanceledPayload>().checked(),
        Definition::read::<AgentQueueItemNotDeliveredPayload>().checked(),
        Definition::read::<AgentQueueItemCreateResponse>().checked(),
        Definition::read::<AgentQueueItemListRequest>().checked(),
        Definition::read::<QueueItemSummary>().checked(),
        Definition::read::<AgentQueueItemListResponse>().checked(),
        Definition::read::<RunQueueStreamChange>(),
        Definition::read::<RunQueueStreamFrame>().checked(),
        Definition::read::<AgentQueueItemSubscribeRequest>().checked(),
        Definition::read::<AgentQueueItemCancelRequest>().checked(),
        Definition::read::<AgentQueueItemCancelResponse>().checked(),
        Definition::read::<AgentQueueItemReorderRequest>().checked(),
        Definition::read::<AgentQueueItemChangeRefusedReason>(),
        Definition::read::<AgentQueueItemChangeRefusedDetails>(),
        Definition::read::<SessionMessageTooLargeDetails>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

impl ListKey for QueueItemId {
    type Key = Self;

    fn list_key(&self) -> Self {
        *self
    }

    // An id carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}
