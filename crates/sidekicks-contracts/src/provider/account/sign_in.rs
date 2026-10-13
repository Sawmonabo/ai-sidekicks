//! The sign-in side of `providerAccount.*`: registering an account, which carries the one request
//! member that may hold a credential; rebuilding an account's credential home; and the brokered
//! interactive sign-in with its cancel. The member a request-logging transport must redact sits
//! here beside the input it concerns.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::keychain::KeychainRefusalCause;
use crate::provider::account::record::{
    BillingMode, CredentialGeneration, DisplayLabel, PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
    ProviderAccount, ProviderAccountHealthState, ProviderAccountId,
};
use crate::provider::name::ProviderName;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::web_address::HttpsAddress;
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest provider verification address, carried verbatim.
    pub const PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN: usize = 2048;
    /// The longest device code the person types at the verification address.
    pub const PROVIDER_LOGIN_USER_CODE_MAX_LEN: usize = 64;
    /// The longest pasted token: generous, since the vendor mints it, and bounded so no unbounded
    /// body rides in through the one member whose value is never logged.
    pub const PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN: usize = 8192;
    /// A pasted token could not be sealed in this machine's keychain, so nothing was stored.
    PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE =
        RefusalCode::ProvideraccountCredentialSealRefused;
    /// The provider's status output, run on a pasted token, reported no signed-in mode, so
    /// nothing is registered, sealed or replaced.
    PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE = RefusalCode::ProvideraccountTokenNotAccepted;
    /// The name given to a token or API-key account repeats another of that provider's account
    /// names; a rename refuses on the same code.
    PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE = RefusalCode::ProvideraccountDisplayLabelTaken;
    /// Every way a cancel ends, in declaration order.
    pub const PROVIDER_LOGIN_CANCEL_STATUSES: [ProviderLoginCancelStatus; 2] =
        [ProviderLoginCancelStatus::Canceled, ProviderLoginCancelStatus::NotFound];
    /// Wire members a request-logging transport redacts before writing a record, listed once so
    /// no transport derives the list again.
    pub const PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS: [&str; 1] = ["nonInteractiveToken"];
}

/// A pasted token or API key: the one credential-accepting input on this wire, write-only. It is
/// on no reply and never logged, shown, echoed or put in an argument vector; it is sealed in the
/// keychain, never written into the credential home.
pub type NonInteractiveToken = FreeFormText<PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN>;

/// Registers an account the provider's own sign-in will name; it carries no name or token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SignInRegistration {
    /// The provider.
    pub provider: ProviderName,
    /// Only an account added from a pasted token carries a name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub display_label: Option<Never>,
    /// How the account is charged.
    pub billing_mode: BillingMode,
    /// Makes it the provider's default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub make_default: Option<bool>,
    /// A re-supply carries a token.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub account_id: Option<Never>,
    /// A sign-in registration carries no token.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub non_interactive_token: Option<Never>,
}

/// Registers a new account from a pasted token or API key, which its provider names nowhere, so
/// the person names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct TokenRegistration {
    /// The provider.
    pub provider: ProviderName,
    /// The name the person gives the account.
    pub display_label: DisplayLabel,
    /// How the account is charged.
    pub billing_mode: BillingMode,
    /// Makes it the provider's default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub make_default: Option<bool>,
    /// A new registration names no account; the daemon mints its id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub account_id: Option<Never>,
    /// The pasted token or API key.
    pub non_interactive_token: NonInteractiveToken,
}

/// Replaces the sealed token of a registered account, the remedy for a token account's lost
/// login, which keeps its spend, quota and attention history; an id that names no account is
/// refused, never created.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct TokenResupply {
    /// The provider, which must match the stored account's.
    pub provider: ProviderName,
    /// A new name for the account.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DisplayLabel")]
    pub display_label: Option<DisplayLabel>,
    /// How the account is charged.
    pub billing_mode: BillingMode,
    /// Makes it the provider's default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub make_default: Option<bool>,
    /// The account whose sealed token is replaced; a selector, not an identity assertion.
    pub account_id: ProviderAccountId,
    /// The fresh token or API key.
    pub non_interactive_token: NonInteractiveToken,
}

/// Registers an account, or re-supplies the token of an existing one. Its name follows the
/// token: a pasted token's new account must be named, a signed-in one is named by its provider,
/// and an `accountId` with nothing to supply is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum ProviderAccountRegisterRequest {
    /// A signed-in account.
    SignIn(SignInRegistration),
    /// A new pasted-token account.
    Token(TokenRegistration),
    /// A fresh token for a registered account.
    Resupply(TokenResupply),
}

/// The registered, or token-replaced, account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountRegisterResponse {
    /// The account.
    #[garde(dive)]
    pub account: ProviderAccount,
}

/// The details of a seal refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountCredentialSealRefusedDetails {
    /// Why the keychain could not be used.
    pub cause: KeychainRefusalCause,
}

/// Rebuilds an account's credential home from empty so the person can sign in again. It raises
/// the credential generation; the identity and stored quota readings survive, and the stored
/// health is dropped, so the reply carries the new one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountResetCredentialHomeRequest {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// The account's new credential generation and health after the rebuild.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountResetCredentialHomeResponse {
    /// The account.
    pub account_id: ProviderAccountId,
    /// The generation after the rebuild, greater than the one before.
    pub credential_generation: CredentialGeneration,
    /// `reauth_required` until the person signs in.
    pub health_state: ProviderAccountHealthState,
}

/// Starts the provider's own interactive sign-in into this account's home.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountLoginRequest {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// What the person needs to finish the sign-in, and the key to cancel it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountLoginResponse {
    /// Opaque, daemon-minted and single-use: the key for cancel and for completion.
    pub attempt_id: FreeFormText<PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN>,
    /// Where the person finishes the flow: the provider's own `https:` address, verbatim, since
    /// the person opens it.
    pub verification_uri: HttpsAddress<PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN>,
    /// The device code the person types at the address, on a device-code flow.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_LOGIN_USER_CODE_MAX_LEN>")]
    pub user_code: Option<FreeFormText<PROVIDER_LOGIN_USER_CODE_MAX_LEN>>,
    /// Where the provider bounds the attempt; absent when it published no bound or the value
    /// failed the daemon's check.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub expires_at: Option<WireInstant>,
}

/// Cancels one sign-in attempt by the id its login reply returned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountLoginCancelRequest {
    /// The attempt.
    pub attempt_id: FreeFormText<PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN>,
}

/// How a cancel ended. `notFound` covers an attempt that already ended or never existed; it is
/// no error, so a client racing a completion sees no refusal for losing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderLoginCancelStatus {
    /// The provider's sign-in was ended.
    Canceled,
    /// No such attempt was open.
    NotFound,
}

/// How the cancel ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountLoginCancelResponse {
    /// The outcome.
    pub status: ProviderLoginCancelStatus,
}

/// The TypeScript module of the account sign-in.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/account/sign-in",
    doc: "The sign-in side of `providerAccount.*`: registering an account, rebuilding an \
          account's credential home, and the brokered interactive sign-in with its cancel.",
    definitions: &[
        Definition::read::<ProviderAccountRegisterRequest>().checked(),
        Definition::read::<ProviderAccountRegisterResponse>().checked(),
        Definition::read::<ProviderAccountCredentialSealRefusedDetails>().checked(),
        Definition::read::<ProviderAccountResetCredentialHomeRequest>().checked(),
        Definition::read::<ProviderAccountResetCredentialHomeResponse>().checked(),
        Definition::read::<ProviderAccountLoginRequest>().checked(),
        Definition::read::<ProviderAccountLoginResponse>().checked(),
        Definition::read::<ProviderAccountLoginCancelRequest>().checked(),
        Definition::read::<ProviderLoginCancelStatus>(),
        Definition::read::<ProviderAccountLoginCancelResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
