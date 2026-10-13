//! The `providerAccount.*` methods not in the sign-in module (update, remove, set-current, probe,
//! memory import, usage read) and the namespace's method table. A credential crosses these
//! methods on one input, the register request's token, and on no output; a refusal of a supplied
//! token names the condition that failed and never quotes the value. No request carries the
//! credential generation, and an `accountId` always names an account the daemon already minted.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::account::record::readiness::ProviderLoginExpiredRemedy;
use crate::provider::account::record::{
    BillingMode, CredentialGeneration, DisplayLabel, ProviderAccount, ProviderAccountHealthState,
    ProviderAccountId, ProviderAccountListRequest, ProviderAccountListResponse,
    ProviderAccountMemoryImportOutcome, ProviderAccountNotification,
};
use crate::provider::account::sign_in::{
    ProviderAccountLoginCancelRequest, ProviderAccountLoginCancelResponse,
    ProviderAccountLoginRequest, ProviderAccountLoginResponse, ProviderAccountRegisterRequest,
    ProviderAccountRegisterResponse, ProviderAccountResetCredentialHomeRequest,
    ProviderAccountResetCredentialHomeResponse,
};
use crate::provider::name::ProviderName;
use crate::session::cost::UsdMicros;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::True;
use crate::wire::date::WireDate;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest model id on a usage row, as the provider names it.
    pub const PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN: usize = 128;
    /// The longest reason the wake helper did not install, in the installer's own words.
    pub const PROVIDER_WAKE_HELPER_REASON_MAX_LEN: usize = 1024;
    /// The update renamed an account the person did not name: only an account added from a
    /// pasted token or API key carries a typed name.
    PROVIDER_ACCOUNT_RENAME_REFUSED_CODE = RefusalCode::ProvideraccountRenameRefused;
    /// No account is registered for the provider a run needs, so the run is not admitted.
    PROVIDER_ACCOUNT_NOT_REGISTERED_CODE = RefusalCode::ProvideraccountNotRegistered;
    /// The provider has accounts but none is current, so a run's account is ambiguous and it is
    /// not admitted.
    PROVIDER_ACCOUNT_NO_DEFAULT_CODE = RefusalCode::ProvideraccountNoDefault;
    /// A run bound to the account is live, so it is not removed; the refusal names the sessions.
    PROVIDER_ACCOUNT_IN_USE_CODE = RefusalCode::ProvideraccountAccountInUse;
    /// The named account is not signed in, so it is refused as a switch target before anything
    /// moves.
    PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE = RefusalCode::ProvideraccountNotAuthenticated;
}

/// Edits an account's descriptive settings; an omitted member is unchanged. The provider, the
/// credential home, the credential generation and the default mark are not changed here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountUpdateRequest {
    /// The account.
    pub account_id: ProviderAccountId,
    /// Renames an account added from a pasted token or API key; refused on any other.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DisplayLabel")]
    pub display_label: Option<DisplayLabel>,
    /// How `unknown` is resolved to a declared mode.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BillingMode")]
    pub billing_mode: Option<BillingMode>,
    /// The lasting per-account opt-out for the background observer; on by default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub probe_enabled: Option<bool>,
    /// Start each usage window as soon as it opens; it does nothing while the observer is off,
    /// and turning it on then is kept rather than refused.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub window_start_enabled: Option<bool>,
    /// Wake this computer for a window that resets while it sleeps; the first account turned on
    /// installs the wake helper and the last one turned off removes it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub wake_for_window_start_enabled: Option<bool>,
}

/// Whether the helper that wakes this computer for a window start is installed; one that did not
/// install leaves the switch off and gives its reason.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderWakeHelperState {
    /// Installed.
    Installed {},
    /// Not installed.
    NotInstalled {
        /// Why, in the installer's own words.
        reason: FreeFormText<PROVIDER_WAKE_HELPER_REASON_MAX_LEN>,
    },
}

/// The updated account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountUpdateResponse {
    /// The account.
    #[garde(dive)]
    pub account: ProviderAccount,
    /// Present when the request changed the wake switch on a machine that uses the helper.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderWakeHelperState")]
    pub wake_helper: Option<ProviderWakeHelperState>,
}

/// Removes one account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountRemoveRequest {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// The removed account's id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountRemoveResponse {
    /// The account.
    pub account_id: ProviderAccountId,
    /// Always `true`: removal has no partial success, and every refusal is a typed error.
    pub removed: True,
}

/// The sessions whose live runs block a removal; at least one is named.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountInUseDetails {
    /// The sessions.
    pub session_ids: BoundedVec<SessionId, 1, { usize::MAX }>,
}

/// Makes this account its provider's current account, the one the default mark sits on. New
/// sessions on that provider start on it and every running session there not pinned to an
/// account moves to it; no credential is touched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountSetCurrentRequest {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// One running session the switch is moving, in place, at its next provider request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountMovingSession {
    /// The session.
    pub session_id: SessionId,
}

/// The account now current and the sessions the switch is moving.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("allOf" = [{ "type": "object", "properties": { "account": {
    "type": "object",
    "properties": { "isDefault": { "const": true } },
} } }]))]
pub struct ProviderAccountSetCurrentResponse {
    /// The account now current, so it carries the default mark.
    #[garde(dive, custom(is_default_account))]
    pub account: ProviderAccount,
    /// The sessions the switch is moving; empty when nothing ran on that provider or the account
    /// was already current.
    pub moving_sessions: Vec<ProviderAccountMovingSession>,
}

/// Whether the account carries the default mark.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn is_default_account(account: &ProviderAccount, (): &()) -> garde::Result {
    if account.is_default() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "the account made current must carry the default mark",
        ))
    }
}

/// The refused account's own remedy, so the refusal points at the one way back for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountNotAuthenticatedDetails {
    /// The remedy.
    pub remedy: ProviderLoginExpiredRemedy,
}

/// Checks one account's health now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountProbeRequest {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// The account's health as the probe read it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountProbeResponse {
    /// The account.
    pub account_id: ProviderAccountId,
    /// The health read.
    pub health_state: ProviderAccountHealthState,
    /// The generation the probe saw; a later rise makes this reading stale.
    pub credential_generation: CredentialGeneration,
}

/// Copies the person's own provider memory into this account's home, once, never overwriting a
/// file, and answers with the outcome the account keeps, so a repeat never copies twice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountMemoryImportRequest {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// A usage read of one account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct AccountUsageScope {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// A usage read of every account of one provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ProviderUsageScope {
    /// The provider.
    pub provider: ProviderName,
}

/// The accounts a usage read covers: one account, or every account of one provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProviderAccountUsageScope {
    /// One account.
    Account(AccountUsageScope),
    /// One provider's accounts.
    Provider(ProviderUsageScope),
}

/// How a usage read splits its figures: by calendar day, or by model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAccountUsageGrouping {
    /// By calendar day.
    Day,
    /// By model.
    Model,
}

/// Reads tokens and spend per account from the per-turn records; a subscription account's tokens
/// are priced at the provider's published per-token rates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountUsageReadRequest {
    /// The accounts read.
    pub scope: ProviderAccountUsageScope,
    /// The inclusive start; absent reads from the first recorded turn.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub from: Option<WireInstant>,
    /// The exclusive end; absent reads to now.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub to: Option<WireInstant>,
    /// How the figures split; absent gives one row for the whole range.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderAccountUsageGrouping")]
    pub group_by: Option<ProviderAccountUsageGrouping>,
}

/// One figure: the tokens and what they cost, in whole micro-dollars. `day` is set on a row
/// grouped by day and `model` on a row grouped by model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountUsageRow {
    /// The calendar day.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireDate")]
    #[garde(dive)]
    pub day: Option<WireDate>,
    /// The model, as the provider names it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN>")]
    pub model: Option<FreeFormText<PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN>>,
    /// The tokens.
    pub tokens: SafeInt<0>,
    /// What they cost.
    pub cost_usd_micros: UsdMicros,
}

/// The usage rows for the requested range and grouping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountUsageReadResponse {
    /// The rows.
    #[garde(dive)]
    pub rows: Vec<ProviderAccountUsageRow>,
}

methods! {
    /// Every `providerAccount.*` method: its name, how it answers, and its shapes.
    pub const PROVIDER_ACCOUNT_METHOD_DESCRIPTORS = [
        /// Reads the accounts, their quota readings and each provider's readiness.
        ProviderAccountList = query "providerAccount.list" {
            mutating: false,
            params: ProviderAccountListRequest,
            result: ProviderAccountListResponse,
            refusals: [ProvideraccountUnknown],
        },
        /// Streams every change to the account registry.
        ProviderAccountSubscribe = subscription "providerAccount.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAckResponse,
            emission: ProviderAccountNotification,
            refusals: [],
        },
        /// Registers an account, or re-supplies a token account's token.
        ProviderAccountRegister = mutation "providerAccount.register" {
            mutating: true,
            params: ProviderAccountRegisterRequest,
            result: ProviderAccountRegisterResponse,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountCredentialSealRefused,
                ProvideraccountTokenNotAccepted,
                ProvideraccountDisplayLabelTaken,
                ProvideraccountDefaultConflict,
                ProvideraccountCredentialHomeUnavailable,
            ],
        },
        /// Edits an account's descriptive settings.
        ProviderAccountUpdate = mutation "providerAccount.update" {
            mutating: true,
            params: ProviderAccountUpdateRequest,
            result: ProviderAccountUpdateResponse,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountRenameRefused,
                ProvideraccountDisplayLabelTaken,
            ],
        },
        /// Removes an account.
        ProviderAccountRemove = mutation "providerAccount.remove" {
            mutating: true,
            params: ProviderAccountRemoveRequest,
            result: ProviderAccountRemoveResponse,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountAccountInUse,
            ],
        },
        /// Makes an account its provider's current one.
        ProviderAccountSetCurrent = mutation "providerAccount.setCurrent" {
            mutating: true,
            params: ProviderAccountSetCurrentRequest,
            result: ProviderAccountSetCurrentResponse,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountNotAuthenticated,
                ProvideraccountDefaultConflict,
                ProvideraccountCredentialHomeUnavailable,
            ],
        },
        /// Checks an account's health now.
        ProviderAccountProbe = mutation "providerAccount.probe" {
            mutating: true,
            params: ProviderAccountProbeRequest,
            result: ProviderAccountProbeResponse,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountCredentialHomeUnavailable,
            ],
        },
        /// Rebuilds an account's credential home from empty.
        ProviderAccountResetCredentialHome = mutation "providerAccount.resetCredentialHome" {
            mutating: true,
            params: ProviderAccountResetCredentialHomeRequest,
            result: ProviderAccountResetCredentialHomeResponse,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountCredentialHomeUnavailable,
            ],
        },
        /// Starts the provider's own interactive sign-in.
        ProviderAccountLogin = mutation "providerAccount.login" {
            mutating: true,
            params: ProviderAccountLoginRequest,
            result: ProviderAccountLoginResponse,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountSigninInFlight,
                ProvideraccountSigninUnsupported,
                ProvideraccountCredentialHomeUnavailable,
            ],
        },
        /// Cancels a sign-in attempt.
        ProviderAccountLoginCancel = mutation "providerAccount.loginCancel" {
            mutating: true,
            params: ProviderAccountLoginCancelRequest,
            result: ProviderAccountLoginCancelResponse,
            refusals: [ProvideraccountPermissionDenied],
        },
        /// Copies the person's provider memory into the account's home, once.
        ProviderAccountMemoryImport = mutation "providerAccount.memoryImport" {
            mutating: true,
            params: ProviderAccountMemoryImportRequest,
            result: ProviderAccountMemoryImportOutcome,
            refusals: [
                ProvideraccountPermissionDenied,
                ProvideraccountUnknown,
                ProvideraccountCredentialHomeUnavailable,
            ],
        },
        /// Reads tokens and spend per account.
        ProviderAccountUsageRead = query "providerAccount.usageRead" {
            mutating: false,
            params: ProviderAccountUsageReadRequest,
            result: ProviderAccountUsageReadResponse,
            refusals: [ProvideraccountUnknown],
        },
    ];
}

/// The TypeScript module of the account methods.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/account/methods",
    doc: "The `providerAccount.*` methods not in the sign-in module (update, remove, set-current, \
          probe, memory import, usage read) and the namespace's method table.",
    definitions: &[
        Definition::read::<ProviderAccountUpdateRequest>(),
        Definition::read::<ProviderWakeHelperState>(),
        Definition::read::<ProviderAccountUpdateResponse>(),
        Definition::read::<ProviderAccountRemoveRequest>(),
        Definition::read::<ProviderAccountRemoveResponse>(),
        Definition::read::<ProviderAccountInUseDetails>().checked(),
        Definition::read::<ProviderAccountSetCurrentRequest>(),
        Definition::read::<ProviderAccountMovingSession>(),
        Definition::read::<ProviderAccountSetCurrentResponse>(),
        Definition::read::<ProviderAccountNotAuthenticatedDetails>().checked(),
        Definition::read::<ProviderAccountProbeRequest>(),
        Definition::read::<ProviderAccountProbeResponse>(),
        Definition::read::<ProviderAccountMemoryImportRequest>(),
        Definition::read::<ProviderAccountUsageScope>(),
        Definition::read::<ProviderAccountUsageGrouping>(),
        Definition::read::<ProviderAccountUsageReadRequest>(),
        Definition::read::<ProviderAccountUsageRow>(),
        Definition::read::<ProviderAccountUsageReadResponse>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PROVIDER_ACCOUNT_METHOD_DESCRIPTORS],
};
