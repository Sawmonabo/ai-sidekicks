//! The approval contract: the calls that answer an agent's ask, list the pending asks, list and
//! revoke the remembered rules, and allow once an action the provider's own reviewer blocked, with
//! the payloads of the `approval.*` events the daemon records for each.
//!
//! The daemon raises every ask, from a provider's callback or from a workflow's command step, so
//! no client creates one. An ask is held with no timer until it is answered or its run ends, so
//! nothing here names an expiry. A remembered rule is handed to the provider that runs the
//! session, which keeps it: for this session, or in the provider's own rule file for this project.
//! The daemon keeps no rule store; it lists the session's own answers and the project's rule
//! files, and a rule holds at every level that asks.

pub mod events;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::internal::branded::branded_uuid_id;
use crate::method::methods;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::ClientUuid;
use crate::wire::instant::WireInstant;
use crate::wire::record::JsonRecord;
use crate::wire::text::{FreeFormText, NonEmptyText};
use crate::wire::{Never, literal};

ts_constants! {
    /// Every approval category, for the category each agent tool carries.
    APPROVAL_CATEGORIES = ApprovalCategory::VARIANTS;
}

/// An ask's target scope, free text such as a command or a path.
pub type ApprovalScope = FreeFormText<FILE_PATH_MAX_LEN>;

branded_uuid_id! {
    /// The daemon-minted id of one ask.
    ApprovalRequestId
}

branded_uuid_id! {
    /// The id of one remembered rule: `approval.rule.list` names it and `approval.rule.revoke`
    /// takes it.
    RememberedRuleId
}

branded_uuid_id! {
    /// The daemon-minted id of one block by a provider's own reviewer.
    ReviewerDenialId
}

/// What an ask is about. An agent's question and a tool server's question are not asks: they are
/// the one question record, so neither is a category here.
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
pub enum ApprovalCategory {
    /// Running a tool.
    ToolExecution,
    /// Writing a file.
    FileWrite,
    /// Reaching the network.
    NetworkAccess,
    /// A git command that destroys work.
    DestructiveGit,
    /// Approving a plan.
    PlanApproval,
    /// A workflow gate.
    Gate,
}

/// Where an ask stands. There is no expired state: an ask waits until it is answered, and the only
/// ends besides an answer cancel it with its run.
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
pub enum ApprovalState {
    /// Waiting on an answer.
    Pending,
    /// Approved.
    Approved,
    /// Declined.
    Rejected,
    /// Ended with its run.
    Canceled,
}

/// The person's answer to an ask.
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
pub enum ApprovalDecision {
    /// Approved.
    Approved,
    /// Declined.
    Rejected,
}

impl ApprovalDecision {
    /// The sense of the rule the decision mints: an approval allows, a decline blocks.
    pub fn remembered_sense(self) -> RememberedRuleSense {
        match self {
            Self::Approved => RememberedRuleSense::Allow,
            Self::Rejected => RememberedRuleSense::Block,
        }
    }
}

literal! {
    /// The decision of an approved ask.
    pub enum ApprovedDecision = "approved";
    /// The decision of a declined ask.
    pub enum RejectedDecision = "rejected";
    /// The trigger of a revoke the person asked for.
    pub enum ExplicitInvalidation = "explicit";
}

/// A remembered rule's reach: this session, kept by the provider for the session, or every session
/// on this project, kept in the provider's own project rule file.
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
pub enum RememberedScopeKind {
    /// This session.
    Session,
    /// Every session on this project.
    Project,
}

/// Whether a rule allows its subject or blocks it. A block is the remembered form of a network
/// decline: that host is refused with no card until the rule is replaced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RememberedRuleSense {
    /// Allows its subject.
    Allow,
    /// Blocks its subject.
    Block,
}

/// Why `approval.resolutionInvalid` refused an answer: a block on an ask that is not a network
/// request, a rule the ask does not offer, a rule over other words than the subject the card named,
/// a scope other than the one asked, a correction on an ask whose command or path cannot be
/// corrected, or a correction and a rule together.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalResolutionInvalidReason {
    /// A block on an ask that is not a network request.
    BlockOutsideNetworkAccess,
    /// A rule the ask does not offer.
    RuleNotOffered,
    /// A rule over other words than the subject the card named.
    SubjectMismatch,
    /// A scope other than the one asked.
    EffectiveScopeBroader,
    /// A correction on an ask that cannot be corrected.
    EditNotOffered,
    /// A correction and a rule together.
    EditWithRule,
}

/// Why `approval.requestCanceled` refused a create: the run ended or the session closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalLateCreateReason {
    /// The run ended.
    RunEnded,
    /// The session closed.
    SessionClosed,
}

/// Why a rule ended: the person revoked it, its session ended, or its tool server was removed. A
/// project's rules live in the project's own folder and stay with it.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum InvalidationTrigger {
    /// The person revoked it.
    Explicit,
    /// Its session ended.
    SessionEnd,
    /// Its tool server was removed.
    ServerRemoved,
}

/// The rule a resolution mints. `pattern` is the subject the daemon derived from the ask and the
/// card's button showed: a command's program and first subcommand, a network request's host, a
/// written file's name. The client echoes what it showed, and the daemon refuses an echo that
/// differs from its own derivation, so a rule never covers more than the words the person pressed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RememberedScope {
    /// Its reach.
    pub kind: RememberedScopeKind,
    /// Its subject.
    pub pattern: NonEmptyText,
    /// Whether it allows or blocks.
    pub sense: RememberedRuleSense,
}

/// A garde check that a minted rule, where there is one, has `sense`, the sense its decision gives.
fn remembers(
    sense: RememberedRuleSense,
) -> impl Fn(&Option<RememberedScope>, &()) -> garde::Result {
    move |scope, _context| match scope {
        Some(scope) if scope.sense != sense => Err(garde::Error::new(
            "an approval remembers an allow and a decline remembers a block",
        )),
        Some(_) | None => Ok(()),
    }
}

/// Declares `ApprovalResolveRequest` with the members both decisions repeat.
macro_rules! approval_resolve_request {
    ($($(#[doc = $doc:literal])+ $arm:ident { $($fields:tt)* })+) => {
        /// `approval.resolve`: one answer to an ask. A rule's sense agrees with the decision, only
        /// a decline carries `declineReason`, and only an approval carries `editedAction`.
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "decision",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum ApprovalResolveRequest {$(
            $(#[doc = $doc])+
            $arm {
                /// The ask.
                approval_request_id: ApprovalRequestId,
                /// Minted by the answering client and echoed on the resolution event, so the
                /// device that settled the ask draws nothing and every other device draws that it
                /// was answered elsewhere.
                client_resolution_id: ClientUuid,
                /// Never broader than what was asked; defaults to the ask's own scope.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "ApprovalScope")]
                effective_scope: Option<ApprovalScope>,
                /// Free-form audit members.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "JsonRecord")]
                audit_metadata: Option<JsonRecord>,
                $($fields)*
            },
        )+}
    };
}

approval_resolve_request! {
    /// An approval.
    Approved {
        /// The command or path as the person changed it on the card before approving: what goes
        /// back to the provider and what the row records as having run.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "NonEmptyText")]
        edited_action: Option<NonEmptyText>,
        /// Never present: only a decline carries a reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        decline_reason: Option<Never>,
        /// The rule to remember, an allow; absent for a one-time answer.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RememberedScope")]
        #[schemars(extend("type" = "object", "properties" = { "sense": { "const": "allow" } }))]
        #[garde(custom(remembers(RememberedRuleSense::Allow)))]
        remembered_scope: Option<RememberedScope>,
    }
    /// A decline.
    Rejected {
        /// The `why not` line, sent to the agent through the provider's own refusal field.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "NonEmptyText")]
        decline_reason: Option<NonEmptyText>,
        /// Never present: only an approval carries an edited action.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        edited_action: Option<Never>,
        /// The rule to remember, a block; absent for a one-time answer.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RememberedScope")]
        #[schemars(extend("type" = "object", "properties" = { "sense": { "const": "block" } }))]
        #[garde(custom(remembers(RememberedRuleSense::Block)))]
        remembered_scope: Option<RememberedScope>,
    }
}

/// What an answer settled: the device that answered, the recorded scope and the time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApprovalResolveResponse {
    /// The ask.
    pub approval_request_id: ApprovalRequestId,
    /// Where it now stands.
    pub state: ApprovalState,
    /// The device that answered.
    pub device_id: DeviceId,
    /// The recorded scope.
    pub effective_scope: ApprovalScope,
    /// When.
    #[garde(dive)]
    pub resolved_at: WireInstant,
}

/// `approval.list`: the session's asks, optionally narrowed by state or category.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApprovalListRequest {
    /// The session.
    pub session_id: SessionId,
    /// Only asks in this state.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ApprovalState")]
    pub state: Option<ApprovalState>,
    /// Only asks of this category.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ApprovalCategory")]
    pub category: Option<ApprovalCategory>,
}

/// Declares `ApprovalProjectionRow` with the members every state repeats.
macro_rules! approval_projection_row {
    (
        unresolved: [$($(#[doc = $unresolved_doc:literal])+ $unresolved:ident),+ $(,)?],
        resolved: [$($resolved:tt)+] $(,)?
    ) => {
        approval_projection_row! {
            @arms
            $($(#[doc = $unresolved_doc])+ $unresolved {
                /// Never present on an unresolved ask.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                resolved_at: Option<Never>,
                /// Never present on an unresolved ask.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                decision: Option<Never>,
                /// Never present on an unresolved ask.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                device_id: Option<Never>,
                /// Never present on an unresolved ask.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                effective_scope: Option<Never>,
                /// Never present on an unresolved ask.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                remembered_scope: Option<Never>,
            })+
            $($resolved)+
        }
    };
    (@arms $($(#[doc = $doc:literal])+ $arm:ident { $($fields:tt)* })+) => {
        /// One ask as the card draws it. A resolved ask carries `resolvedAt`, `decision`,
        /// `deviceId` and `effectiveScope`, its decision is its state, and only it may carry a
        /// minted rule, with the sense its decision gives; no other ask carries any of them. The
        /// project scope is offered only beside a standing allow.
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "state",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        #[garde(custom(offers_the_project_only_beside_a_standing_allow))]
        #[schemars(extend(
            "type" = "object",
            "if" = {
                "type": "object",
                "properties": { "projectScopeOffered": { "const": true } },
                "required": ["projectScopeOffered"],
            },
            "then" = {
                "type": "object",
                "properties": { "standingAllowOffered": { "const": true } },
            },
        ))]
        pub enum ApprovalProjectionRow {$(
            $(#[doc = $doc])+
            $arm {
                /// The ask.
                id: ApprovalRequestId,
                /// Its run.
                run_id: RunId,
                /// Who asked.
                requested_by: NonEmptyText,
                /// What it is about.
                category: ApprovalCategory,
                /// Its target scope.
                scope: ApprovalScope,
                /// What it would touch, as the provider described it.
                resource_descriptor: JsonRecord,
                /// The subject the daemon derived from the ask: the words the standing-allow
                /// button names.
                subject: NonEmptyText,
                /// The provider's own line saying why this action stopped, control characters and
                /// escape codes stripped; absent where the provider sent none.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "NonEmptyText")]
                reason: Option<NonEmptyText>,
                /// False where the provider forbids a standing allow; the card then draws only
                /// `Decline` and `Approve once`.
                standing_allow_offered: bool,
                /// Whether that standing allow may also be written for the whole project: false
                /// on a chat, which has no project, and on a workflow command step's ask, which no
                /// provider relayed.
                project_scope_offered: bool,
                /// When it was raised.
                #[garde(dive)]
                created_at: WireInstant,
                /// When it last changed.
                #[garde(dive)]
                updated_at: WireInstant,
                $($fields)*
            },
        )+}

        impl ApprovalProjectionRow {
            /// Whether the row offers a standing allow, and whether it offers the project scope.
            fn offers(&self) -> (bool, bool) {
                match self {$(
                    Self::$arm { standing_allow_offered, project_scope_offered, .. } => {
                        (*standing_allow_offered, *project_scope_offered)
                    }
                )+}
            }
        }
    };
}

approval_projection_row! {
    unresolved: [
        /// Waiting on an answer.
        Pending,
        /// Ended with its run.
        Canceled,
    ],
    resolved: [
    /// Approved.
    Approved {
        /// When it was answered.
        #[garde(dive)]
        resolved_at: WireInstant,
        /// Always `approved`.
        decision: ApprovedDecision,
        /// The device that answered.
        device_id: DeviceId,
        /// The recorded scope.
        effective_scope: ApprovalScope,
        /// The rule the answer minted, an allow.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RememberedScope")]
        #[schemars(extend("type" = "object", "properties" = { "sense": { "const": "allow" } }))]
        #[garde(custom(remembers(RememberedRuleSense::Allow)))]
        remembered_scope: Option<RememberedScope>,
    }
    /// Declined.
    Rejected {
        /// When it was answered.
        #[garde(dive)]
        resolved_at: WireInstant,
        /// Always `rejected`.
        decision: RejectedDecision,
        /// The device that answered.
        device_id: DeviceId,
        /// The recorded scope.
        effective_scope: ApprovalScope,
        /// The rule the answer minted, a block.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RememberedScope")]
        #[schemars(extend("type" = "object", "properties" = { "sense": { "const": "block" } }))]
        #[garde(custom(remembers(RememberedRuleSense::Block)))]
        remembered_scope: Option<RememberedScope>,
    }
    ],
}

/// Refuses a row that offers the project scope without a standing allow beside it.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn offers_the_project_only_beside_a_standing_allow(
    row: &ApprovalProjectionRow,
    (): &(),
) -> garde::Result {
    match row.offers() {
        (false, true) => Err(garde::Error::new(
            "the project scope is offered only beside a standing allow",
        )),
        (true, _) | (false, false) => Ok(()),
    }
}

/// The session's asks.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalListResponse {
    /// The asks.
    #[garde(dive)]
    pub approvals: Vec<ApprovalProjectionRow>,
}

/// `approval.rule.list`: the rules in force on one session, its own and its project's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApprovalRuleListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One rule in force, as the inspector's row reads it: what it does, and the derived subject and
/// the scope in words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RememberedRule {
    /// The rule.
    pub rule_id: RememberedRuleId,
    /// What it is about.
    pub category: ApprovalCategory,
    /// Its reach, subject and sense.
    pub scope: RememberedScope,
    /// When it was granted.
    #[garde(dive)]
    pub granted_at: WireInstant,
}

/// The rules in force.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRuleListResponse {
    /// The rules.
    #[garde(dive)]
    pub rules: Vec<RememberedRule>,
}

/// `approval.rule.revoke`: revokes one rule; a project rule's revoke removes it from the provider's
/// project rule file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApprovalRuleRevokeRequest {
    /// The rule.
    pub rule_id: RememberedRuleId,
}

/// A revocation's receipt. A revocation through this call is always `explicit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApprovalRuleRevokeResponse {
    /// The rule.
    pub rule_id: RememberedRuleId,
    /// When.
    #[garde(dive)]
    pub revoked_at: WireInstant,
    /// Always `explicit`.
    pub invalidation_trigger: ExplicitInvalidation,
}

/// `approval.denial.override`: allows once an action the provider's own reviewer blocked. The
/// daemon tells the agent it may retry that one action, by each provider's own means; the agent
/// decides whether to retry. A press on a block already allowed is answered with the settled
/// override and sends nothing a second time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApprovalDenialOverrideRequest {
    /// The session.
    pub session_id: SessionId,
    /// The block.
    pub denial_id: ReviewerDenialId,
}

/// When the block was allowed once, the first time it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ApprovalDenialOverrideResponse {
    /// The block.
    pub denial_id: ReviewerDenialId,
    /// When it was allowed.
    #[garde(dive)]
    pub overridden_at: WireInstant,
}

methods! {
    /// The `approval.*` methods a client calls.
    pub const APPROVAL_METHOD_DESCRIPTORS = [
        /// Answers an ask.
        ApprovalResolve = mutation "approval.resolve" {
            mutating: true,
            params: ApprovalResolveRequest,
            result: ApprovalResolveResponse,
            refusals: [
                ApprovalNotFound,
                ApprovalAlreadyResolved,
                ApprovalRequestCanceled,
                ApprovalResolutionInvalid,
                ApprovalPersistenceUnavailable,
                ApprovalRuleNotKept,
            ],
        },
        /// The session's asks.
        ApprovalList = query "approval.list" {
            mutating: false,
            params: ApprovalListRequest,
            result: ApprovalListResponse,
            refusals: [SessionNotFound],
        },
        /// The rules in force on a session.
        ApprovalRuleList = query "approval.rule.list" {
            mutating: false,
            params: ApprovalRuleListRequest,
            result: ApprovalRuleListResponse,
            refusals: [SessionNotFound],
        },
        /// Revokes one rule.
        ApprovalRuleRevoke = mutation "approval.rule.revoke" {
            mutating: true,
            params: ApprovalRuleRevokeRequest,
            result: ApprovalRuleRevokeResponse,
            refusals: [ApprovalRuleNotFound, ApprovalRuleAlreadyRevoked, ApprovalRuleNotKept],
        },
        /// Allows once an action the provider's reviewer blocked.
        ApprovalDenialOverride = mutation "approval.denial.override" {
            mutating: true,
            params: ApprovalDenialOverrideRequest,
            result: ApprovalDenialOverrideResponse,
            refusals: [
                SessionNotFound,
                ApprovalDenialNotFound,
                ApprovalDenialNotOverridable,
                SessionAlreadyClosed,
                SessionChangeRefused,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderTimeout,
            ],
        },
    ];
}

/// The TypeScript module of approvals.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "approval",
    doc: "The approval contract: answering an agent's ask, the pending asks, the remembered \
          rules, allowing a reviewer's block once, and the `approval.*` event payloads.",
    definitions: &[
        Definition::read::<ApprovalRequestId>().checked(),
        Definition::read::<RememberedRuleId>().checked(),
        Definition::read::<ReviewerDenialId>().checked(),
        Definition::read::<ApprovalCategory>().checked(),
        Definition::read::<ApprovalState>().checked(),
        Definition::read::<ApprovalDecision>().checked(),
        Definition::read::<RememberedScopeKind>().checked(),
        Definition::read::<RememberedRuleSense>().checked(),
        Definition::read::<ApprovalResolutionInvalidReason>(),
        Definition::read::<ApprovalLateCreateReason>(),
        Definition::read::<InvalidationTrigger>().checked(),
        Definition::read::<RememberedScope>().checked(),
        Definition::read::<ApprovalResolveRequest>().checked(),
        Definition::read::<ApprovalResolveResponse>().checked(),
        Definition::read::<ApprovalListRequest>().checked(),
        Definition::read::<ApprovalProjectionRow>().checked(),
        Definition::read::<ApprovalListResponse>().checked(),
        Definition::read::<ApprovalRuleListRequest>().checked(),
        Definition::read::<RememberedRule>().checked(),
        Definition::read::<ApprovalRuleListResponse>().checked(),
        Definition::read::<ApprovalRuleRevokeRequest>().checked(),
        Definition::read::<ApprovalRuleRevokeResponse>().checked(),
        Definition::read::<ApprovalDenialOverrideRequest>().checked(),
        Definition::read::<ApprovalDenialOverrideResponse>().checked(),
        Definition::read::<events::ApprovalRequestedPayload>().checked(),
        Definition::read::<events::ApprovalResolvedPayload>().checked(),
        Definition::read::<events::ApprovalCanceledPayload>().checked(),
        Definition::read::<events::ApprovalRuleRememberedPayload>().checked(),
        Definition::read::<events::ApprovalRuleRevokedPayload>().checked(),
        Definition::read::<events::ApprovalReviewerDeniedPayload>().checked(),
        Definition::read::<events::ApprovalDenialOverriddenPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&APPROVAL_METHOD_DESCRIPTORS],
};
