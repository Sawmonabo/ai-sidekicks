//! The attention projection (machine-wide, whole on every emission) and the `attention.*`
//! methods: banner settling, seen marking, and delivery by web address or email digest, whose
//! secrets the daemon seals and never sends back.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::keychain::KeychainRefusalCause;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::text::{FreeFormText, NonEmptyText};
use crate::wire::{Never, NullableSchema, literal, nullable};
use crate::workflow::definition::document::WorkflowNodeId;
use crate::workflow::run::id::WorkflowRunId;

ts_constants! {
    /// The longest id an attention entry carries: its own, its moment's, its run's and its source
    /// event's. The daemon mints each of them.
    pub const ATTENTION_ID_MAX_LEN: usize = 256;
    /// The longest mail password or web address the daemon accepts.
    pub const ATTENTION_DELIVERY_SECRET_MAX_LEN: usize = 8192;
    /// Every attention trigger; a client never invents one.
    ATTENTION_TRIGGERS = AttentionTrigger::VARIANTS;
    /// Every attention severity.
    ATTENTION_SEVERITIES = AttentionSeverity::VARIANTS;
    /// Every banner state, for the main process's poster, which posts only pending entries.
    ATTENTION_BANNER_STATES = AttentionBannerState::VARIANTS;
    /// Every web-address state, for the send and the status line that counts what stays
    /// undelivered.
    ATTENTION_WEB_ADDRESS_STATES = AttentionWebAddressState::VARIANTS;
}

/// An id an attention entry carries, minted by the daemon.
pub type AttentionId = FreeFormText<ATTENTION_ID_MAX_LEN>;

/// Every attention trigger: pending approval or user input, run completion, run failure, and a
/// workflow's Notify step. The set is closed.
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
pub enum AttentionTrigger {
    /// A pending approval.
    PendingApproval,
    /// Pending user input.
    PendingInput,
    /// A run completed.
    RunCompleted,
    /// A run failed.
    RunFailed,
    /// A workflow's Notify step.
    WorkflowNotify,
}

/// The triggers of a run's or session's own moment: every trigger but a Notify step's.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum AttentionMomentTrigger {
    /// A pending approval.
    PendingApproval,
    /// Pending user input.
    PendingInput,
    /// A run completed.
    RunCompleted,
    /// A run failed.
    RunFailed,
}

/// The two severities: `actionable` attention blocks on the person, `informational` does not. A
/// client renders the two differently.
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
pub enum AttentionSeverity {
    /// Blocks on the person.
    Actionable,
    /// Does not block on the person.
    Informational,
}

/// What became of an entry's operating-system banner, absent until the daemon decides it. The
/// daemon writes `withheld` when a switch or a mute keeps the entry from raising one, and `pending`
/// otherwise; main posts only a `pending` entry and settles it once, so no banner is posted twice.
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
pub enum AttentionBannerState {
    /// Not yet settled by main.
    Pending,
    /// Posted.
    Posted,
    /// Kept from raising a banner.
    Withheld,
    /// Taken down.
    Withdrawn,
}

/// A banner state main settles a `pending` entry to; settling back to `pending` is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttentionBannerSettledState {
    /// Posted.
    Posted,
    /// Kept from raising a banner.
    Withheld,
    /// Taken down.
    Withdrawn,
}

/// Where an entry's message to the person's web address stands.
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
pub enum AttentionWebAddressState {
    /// Not yet sent, or being retried.
    Pending,
    /// Accepted by the address.
    Delivered,
    /// Given up on.
    Undelivered,
}

literal! {
    /// The trigger of a workflow's Notify step.
    pub enum WorkflowNotifyTrigger = "workflowNotify";
    /// The severity of a Notify step's entry, which never counts as waiting on the person.
    pub enum InformationalSeverity = "informational";
}

fn web_address_send_is_whole(has_state: bool, has_attempt_count: bool) -> garde::Result {
    if has_state == has_attempt_count {
        Ok(())
    } else {
        Err(garde::Error::new(
            "webAddressState and webAddressAttemptCount are present together",
        ))
    }
}

/// Declares one arm of an attention item with the members every arm repeats.
macro_rules! attention_item {
    ($(#[doc = $doc:literal])+ $name:ident { $($arm:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        #[schemars(inline)]
        #[schemars(extend("dependentRequired" = {
            "webAddressState": ["webAddressAttemptCount"],
            "webAddressAttemptCount": ["webAddressState"],
        }))]
        pub struct $name {
            /// The entry.
            pub id: AttentionId,
            /// The session or run and the state it is in, so a later state replaces the
            /// operating-system banner in place: `run:<runId>`, `workflowRun:<workflowRunId>`,
            /// `plan:<planId>` or `session:<sessionId>`, and for a Notify step, which is also its
            /// entry's id, `notify:` and 32 hex digits of the BLAKE3 hash of its run, node and
            /// execution index. The daemon mints each form within the 64 bytes a banner's tag and a
            /// push's collapse id hold.
            pub moment_id: AttentionId,
            /// The session.
            pub session_id: SessionId,
            $($arm)*
            /// The name the entry leads with.
            pub display_name: NonEmptyText,
            /// What follows the name: `Waiting on you`, `Finished`, `Failed`, or a notice.
            pub state_word: NonEmptyText,
            /// The canonical event that triggered the entry.
            pub source_event_id: AttentionId,
            /// When the entry was made.
            #[garde(dive)]
            pub created_at: WireInstant,
            /// Set once the state that produced the entry resolves; absent means outstanding.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WireInstant")]
            #[garde(dive)]
            pub resolved_at: Option<WireInstant>,
            /// What became of its banner; absent until the daemon decides it, and main posts only
            /// `pending`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "AttentionBannerState")]
            pub banner_state: Option<AttentionBannerState>,
            /// Where its message to the web address stands; present exactly when it is sent there.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "AttentionWebAddressState")]
            pub web_address_state: Option<AttentionWebAddressState>,
            /// How many sends it took; present exactly with `webAddressState`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "SafeInt<0>")]
            #[garde(custom(|count: &Option<SafeInt<0>>, (): &()| {
                web_address_send_is_whole(self.web_address_state.is_some(), count.is_some())
            }))]
            pub web_address_attempt_count: Option<SafeInt<0>>,
            /// The one seen-or-unseen fact the daemon keeps, which the session's row reads too.
            pub seen: bool,
        }
    };
}

attention_item! {
    /// A run's or session's own moment: run-scoped when it carries `runId`, else the
    /// session-scoped aggregate.
    AttentionMomentItem {
        /// The run, on a run-scoped entry.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "AttentionId")]
        pub run_id: Option<AttentionId>,
        /// What raised it.
        pub trigger: AttentionMomentTrigger,
        /// Whether it blocks on the person.
        pub severity: AttentionSeverity,
        /// Never present: only a Notify step's entry names a step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub step_id: Option<Never>,
    }
}

attention_item! {
    /// A workflow's Notify step: it tells the person something, carries its run and step, and
    /// never counts as waiting on them.
    AttentionNotifyItem {
        /// The run.
        pub run_id: AttentionId,
        /// Always `workflowNotify`.
        pub trigger: WorkflowNotifyTrigger,
        /// Always `informational`.
        pub severity: InformationalSeverity,
        /// The Notify node.
        pub step_id: WorkflowNodeId,
    }
}

/// One attention entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum AttentionItem {
    /// A run's or session's own moment.
    Moment(#[garde(dive)] AttentionMomentItem),
    /// A workflow's Notify step.
    Notify(#[garde(dive)] AttentionNotifyItem),
}

/// The whole projection, as every emission of `attention.subscribe` carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionProjection {
    /// Every entry.
    #[garde(dive)]
    pub items: Vec<AttentionItem>,
}

/// How far an `attention.subscribe` that names a session narrows the projection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttentionSubscribeScope {
    /// One run's entries, the run named by `runId`.
    Run,
    /// The session's aggregate alone.
    Session,
}

/// `attention.subscribe`: with no session named, the whole projection across every session and
/// workflow run; naming a session narrows it to that session's entries, or by `scope`. `runId`
/// is present exactly when `scope` is `run`, so a run read never widens to every run, and a
/// `scope` needs a session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend(
    "if" = { "properties": { "scope": { "const": "run" } }, "required": ["scope"] },
    "then" = { "properties": { "runId": true }, "required": ["runId"] },
    "else" = { "not": { "required": ["runId"] } },
    "dependentRequired" = { "scope": ["sessionId"] },
))]
pub struct AttentionSubscribeRequest {
    /// The session to narrow to.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub session_id: Option<SessionId>,
    /// How far to narrow, present only with `sessionId`; absent reads the run entries and the
    /// aggregate together.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AttentionSubscribeScope")]
    #[garde(custom(|scope: &Option<AttentionSubscribeScope>, (): &()| {
        if scope.is_none() || self.session_id.is_some() {
            Ok(())
        } else {
            Err(garde::Error::new("a scope goes only with a session"))
        }
    }))]
    pub scope: Option<AttentionSubscribeScope>,
    /// The run, present exactly when `scope` is `run`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AttentionId")]
    #[garde(custom(|run_id: &Option<AttentionId>, (): &()| {
        if run_id.is_some() == (self.scope == Some(AttentionSubscribeScope::Run)) {
            Ok(())
        } else {
            Err(garde::Error::new("a run id goes exactly with the run scope"))
        }
    }))]
    pub run_id: Option<AttentionId>,
}

/// `attention.banner.settle`: main's record of what became of a `pending` entry's banner. Only this
/// machine's main sends it: the daemon answers `{}` and changes nothing for a settle from another
/// device or for an entry that has left `pending`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionBannerSettleRequest {
    /// The entry.
    pub entry_id: AttentionId,
    /// What became of its banner.
    pub state: AttentionBannerSettledState,
}

/// `attention.seen.update`: marks a subject seen, so its finished and failed entries stop reading
/// as unseen, in the notifications list and on the session's row alike. Opening the session, or a
/// workflow run in it, sends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionSeenUpdateRequest {
    /// What was seen.
    pub subject: AttentionSeenSubject,
}

/// What `attention.seen.update` marks seen: a session, or one workflow run in it, which keeps its
/// own seen fact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionSeenSubject {
    /// The session.
    pub session_id: SessionId,
    /// The workflow run in it, when the run was seen rather than the session.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowRunId")]
    pub run_id: Option<WorkflowRunId>,
}

/// The two ways a moment leaves the machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttentionDeliveryChannel {
    /// The person's web address.
    WebAddress,
    /// The email digest.
    EmailDigest,
}

/// How one delivery attempt ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttentionDeliveryResult {
    /// Accepted.
    Delivered,
    /// Refused by the address.
    Refused,
    /// No answer.
    Unreachable,
    /// No answer in time.
    TimedOut,
    /// The mail server refused the sign-in.
    SignInRefused,
    /// The mail server would not encrypt, so nothing was sent.
    NotEncrypted,
    /// A test of saved web-address text with no scheme and host, so nothing was sent.
    NotAnAddress,
}

/// A channel's last attempt. `httpStatus` is the address's answer, `null` where it gave none;
/// `undelivered` counts the messages given up on since the last delivery.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionDeliveryOutcome {
    /// When.
    #[garde(dive)]
    pub at: WireInstant,
    /// How it ended.
    pub result: AttentionDeliveryResult,
    /// The address's HTTP status, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<BoundedInt<100, 599>>")]
    pub http_status: Option<BoundedInt<100, 599>>,
    /// Messages given up on since the last delivery.
    pub undelivered: SafeInt<0>,
}

/// What the web address last did. The address is shown back as its host only, `null` when nothing
/// is saved or the saved text has no scheme and host; neither the address nor its signing secret
/// is ever sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|delivery: &Self, (): &()| {
    if delivery.saved || delivery.host.is_none() {
        Ok(())
    } else {
        Err(garde::Error::new("host is null when no address is saved"))
    }
}))]
#[schemars(extend(
    "if" = {
        "type": "object",
        "properties": { "saved": { "const": false } },
        "required": ["saved"],
    },
    "then" = { "type": "object", "properties": { "host": { "type": "null" } } },
))]
pub struct AttentionWebAddressDelivery {
    /// Whether an address is saved.
    pub saved: bool,
    /// The saved address's host, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<NonEmptyText>")]
    pub host: Option<NonEmptyText>,
    /// Its last attempt, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<AttentionDeliveryOutcome>")]
    #[garde(dive)]
    pub last_outcome: Option<AttentionDeliveryOutcome>,
}

/// What the email digest last did; the mail password is never sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionEmailDigestDelivery {
    /// Whether a mail password is saved.
    pub password_saved: bool,
    /// Its last attempt, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<AttentionDeliveryOutcome>")]
    #[garde(dive)]
    pub last_outcome: Option<AttentionDeliveryOutcome>,
}

/// What each channel last did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionDeliveryListResponse {
    /// The web address.
    #[garde(dive)]
    pub web_address: AttentionWebAddressDelivery,
    /// The email digest.
    #[garde(dive)]
    pub email_digest: AttentionEmailDigestDelivery,
}

/// `attention.delivery.test`: sends one test message on a channel.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionDeliveryTestRequest {
    /// The channel.
    pub channel: AttentionDeliveryChannel,
}

/// How the test ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionDeliveryTestResponse {
    /// The attempt.
    #[garde(dive)]
    pub outcome: AttentionDeliveryOutcome,
}

/// A delivery secret: the mail password or the web address.
pub type AttentionDeliverySecret = FreeFormText<ATTENTION_DELIVERY_SECRET_MAX_LEN>;

/// `attention.mailPassword.update`: saves the mail account's password. Write-only: it is sealed and
/// never sent back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionMailPasswordUpdateRequest {
    /// The password.
    pub password: AttentionDeliverySecret,
}

/// `attention.webAddress.update`: saves the web address, a secret because chat services put their
/// token in it. Whatever is typed is saved as typed; a text that is not an address is kept, and
/// each message to it fails and is counted as undelivered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionWebAddressUpdateRequest {
    /// The address as typed.
    pub address: AttentionDeliverySecret,
}

/// The saved address's host, `null` for a text with no scheme and host, and the signing secret the
/// receiver checks each message with: minted by the first save and shown this once, `null` on
/// every later save.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionWebAddressUpdateResponse {
    /// The host, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<NonEmptyText>")]
    pub host: Option<NonEmptyText>,
    /// The signing secret, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<NonEmptyText>")]
    pub signing_secret: Option<NonEmptyText>,
}

/// A new signing secret, shown this once; the old one stops verifying at once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttentionWebAddressSecretRotateResponse {
    /// The secret.
    pub signing_secret: NonEmptyText,
}

/// The `attention.delivery.storeUnavailable` refusal's details: why the keychain holding the
/// delivery secrets could not be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionDeliveryStoreUnavailableDetails {
    /// Why.
    pub cause: KeychainRefusalCause,
}

/// What a channel asked to test is missing: the web address, or the mail password.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttentionDeliveryMissing {
    /// The web address.
    Address,
    /// The mail password.
    Password,
}

/// The `attention.delivery.notConfigured` refusal's details.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionDeliveryNotConfiguredDetails {
    /// What is missing.
    pub missing: AttentionDeliveryMissing,
}

methods! {
    /// The `attention.*` methods.
    pub const ATTENTION_METHOD_DESCRIPTORS = [
        /// The machine-wide projection, served live: whole first, then whole on every change.
        AttentionSubscribe = subscription "attention.subscribe" {
            mutating: false,
            params: AttentionSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: AttentionProjection,
            refusals: [SessionNotFound],
        },
        /// Settles a pending entry's banner.
        AttentionBannerSettle = mutation "attention.banner.settle" {
            mutating: true,
            params: AttentionBannerSettleRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Marks a session, or a workflow run in it, seen; a run the session does not hold is
        /// refused `workflow.run.notFound`.
        AttentionSeenUpdate = mutation "attention.seen.update" {
            mutating: true,
            params: AttentionSeenUpdateRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, WorkflowRunNotFound],
        },
        /// What each delivery channel last did.
        AttentionDeliveryList = query "attention.delivery.list" {
            mutating: false,
            params: EmptyPayload,
            result: AttentionDeliveryListResponse,
            refusals: [AttentionDeliveryStoreUnavailable],
        },
        /// Sends one test message on a channel.
        AttentionDeliveryTest = mutation "attention.delivery.test" {
            mutating: true,
            params: AttentionDeliveryTestRequest,
            result: AttentionDeliveryTestResponse,
            refusals: [AttentionDeliveryNotConfigured, AttentionDeliveryStoreUnavailable],
        },
        /// Saves the mail password.
        AttentionMailPasswordUpdate = mutation "attention.mailPassword.update" {
            mutating: true,
            params: AttentionMailPasswordUpdateRequest,
            result: EmptyPayload,
            refusals: [AttentionDeliveryStoreUnavailable],
        },
        /// Removes the mail password.
        AttentionMailPasswordDelete = mutation "attention.mailPassword.delete" {
            mutating: true,
            params: EmptyPayload,
            result: EmptyPayload,
            refusals: [AttentionDeliveryStoreUnavailable],
        },
        /// Saves the web address.
        AttentionWebAddressUpdate = mutation "attention.webAddress.update" {
            mutating: true,
            params: AttentionWebAddressUpdateRequest,
            result: AttentionWebAddressUpdateResponse,
            refusals: [AttentionDeliveryStoreUnavailable],
        },
        /// Mints a new signing secret.
        AttentionWebAddressSecretRotate = mutation "attention.webAddress.secret.rotate" {
            mutating: true,
            params: EmptyPayload,
            result: AttentionWebAddressSecretRotateResponse,
            refusals: [AttentionDeliveryStoreUnavailable],
        },
        /// Removes the web address.
        AttentionWebAddressDelete = mutation "attention.webAddress.delete" {
            mutating: true,
            params: EmptyPayload,
            result: EmptyPayload,
            refusals: [AttentionDeliveryStoreUnavailable],
        },
    ];
}

/// The TypeScript module of the attention projection.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "attention",
    doc: "The attention projection (machine-wide, whole on every emission) and the \
          `attention.*` methods: banner settling, seen marking, and delivery beyond this machine.",
    definitions: &[
        Definition::read::<AttentionTrigger>(),
        Definition::read::<AttentionSeverity>(),
        Definition::read::<AttentionMomentTrigger>(),
        Definition::read::<AttentionBannerSettledState>(),
        Definition::read::<AttentionBannerState>(),
        Definition::read::<AttentionWebAddressState>(),
        Definition::read::<AttentionItem>().checked(),
        Definition::read::<AttentionProjection>().checked(),
        Definition::read::<AttentionSubscribeScope>(),
        Definition::read::<AttentionSubscribeRequest>().checked(),
        Definition::read::<AttentionBannerSettleRequest>().checked(),
        Definition::read::<AttentionSeenSubject>(),
        Definition::read::<AttentionSeenUpdateRequest>(),
        Definition::read::<AttentionDeliveryChannel>(),
        Definition::read::<AttentionDeliveryResult>(),
        Definition::read::<AttentionDeliveryOutcome>(),
        Definition::read::<AttentionWebAddressDelivery>(),
        Definition::read::<AttentionEmailDigestDelivery>(),
        Definition::read::<AttentionDeliveryListResponse>().checked(),
        Definition::read::<AttentionDeliveryTestRequest>(),
        Definition::read::<AttentionDeliveryTestResponse>(),
        Definition::read::<AttentionMailPasswordUpdateRequest>(),
        Definition::read::<AttentionWebAddressUpdateRequest>(),
        Definition::read::<AttentionWebAddressUpdateResponse>(),
        Definition::read::<AttentionWebAddressSecretRotateResponse>(),
        Definition::read::<AttentionDeliveryStoreUnavailableDetails>().checked(),
        Definition::read::<AttentionDeliveryMissing>(),
        Definition::read::<AttentionDeliveryNotConfiguredDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&ATTENTION_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use garde::Validate as _;
    use rstest::rstest;

    use super::AttentionSubscribeRequest;
    use crate::schema::closed_schema_for;

    const SESSION: &str = "0190d2b4-7c3a-7e21-9a4b-5f6c7d8e9f01";

    // The garde check and the schema both hold every narrowing rule, so the daemon and a client
    // refuse the same request. Killed by dropping either garde check or the `dependentRequired`.
    #[rstest]
    #[case::whole_projection("{}", true)]
    #[case::one_session(&format!(r#"{{"sessionId":"{SESSION}"}}"#), true)]
    #[case::session_aggregate(&format!(r#"{{"sessionId":"{SESSION}","scope":"session"}}"#), true)]
    #[case::one_run(
        &format!(r#"{{"sessionId":"{SESSION}","scope":"run","runId":"run-1"}}"#),
        true
    )]
    #[case::run_scope_without_run(&format!(r#"{{"sessionId":"{SESSION}","scope":"run"}}"#), false)]
    #[case::run_with_session_scope(
        &format!(r#"{{"sessionId":"{SESSION}","scope":"session","runId":"run-1"}}"#),
        false
    )]
    #[case::run_without_scope(&format!(r#"{{"sessionId":"{SESSION}","runId":"run-1"}}"#), false)]
    #[case::session_scope_without_session(r#"{"scope":"session"}"#, false)]
    #[case::run_scope_without_session(r#"{"scope":"run","runId":"run-1"}"#, false)]
    fn a_subscribe_request_narrows_only_as_its_session_and_scope_allow(
        #[case] request: &str,
        #[case] is_taken: bool,
    ) {
        let parsed: AttentionSubscribeRequest =
            serde_json::from_str(request).expect("the case reads as a subscribe request");
        assert_eq!(parsed.validate().is_ok(), is_taken, "garde: {request}");

        let schema = closed_schema_for::<AttentionSubscribeRequest>().expect("the schema writes");
        let check = jsonschema::validator_for(&schema).expect("the schema builds a check");
        let json: serde_json::Value = serde_json::from_str(request).expect("the case is JSON");
        assert_eq!(check.is_valid(&json), is_taken, "schema: {request}");
    }
}
