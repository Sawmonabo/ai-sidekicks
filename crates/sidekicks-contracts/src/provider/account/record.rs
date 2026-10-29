//! The provider account record and how it is read: the account as sent on the wire, each provider's
//! readiness and its remedy, the per-limit quota reading, `provider.account.list` and the
//! `provider.account.subscribe` live tail. The auth mode is closed, since the daemon produces every
//! value on the wire; the tolerance sits where a provider's own status output is read.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use strum::{IntoStaticStr, VariantArray, VariantNames};

use crate::place::Place;
use crate::provider::id::ProviderId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::UniqueList;
use crate::wire::number::NonNegativeNumber;
use crate::wire::text::{FreeFormText, branded_text, is_ecmascript_whitespace};

pub mod readiness;

ts_constants! {
    /// The longest daemon-minted account id.
    pub const PROVIDER_ACCOUNT_ID_MAX_LEN: usize = 256;
    /// The longest name the person gives an account.
    pub const PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN: usize = 256;
    /// The longest provider-reported email; RFC 5321 caps a forward path at 320 octets.
    pub const PROVIDER_ACCOUNT_EMAIL_MAX_LEN: usize = 320;
    /// The longest provider-reported organization id.
    pub const PROVIDER_ACCOUNT_ORG_ID_MAX_LEN: usize = 256;
    /// The longest provider-reported organization name.
    pub const PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN: usize = 256;
    /// The longest daemon-minted id of one sign-in attempt.
    pub const PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN: usize = 256;
    /// The longest sign-in failure text shown to the person.
    pub const PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN: usize = 512;
    /// The longest provider limit id.
    pub const PROVIDER_QUOTA_LIMIT_ID_MAX_LEN: usize = 128;
    /// The longest provider label for a quota window.
    pub const PROVIDER_QUOTA_LABEL_MAX_LEN: usize = 256;
    /// The longest provider plan id.
    pub const PROVIDER_ACCOUNT_PLAN_MAX_LEN: usize = 128;
    /// The longest label an account is named by: the reported email, plan and organization with
    /// the two three-character ` · ` separators between them, longer than a typed name beside its
    /// credential's kind.
    pub const PROVIDER_ACCOUNT_LABEL_MAX_LEN: usize = PROVIDER_ACCOUNT_EMAIL_MAX_LEN
        + PROVIDER_ACCOUNT_PLAN_MAX_LEN
        + PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN
        + 2 * 3;
    /// Every account health state, in declaration order.
    PROVIDER_ACCOUNT_HEALTH_STATES = ProviderAccountHealthState::VARIANTS;
    /// Every auth mode, in declaration order.
    PROVIDER_AUTH_MODES = ProviderAuthMode::VARIANTS;
    /// Every source a quota reading comes from, in declaration order.
    PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES = ProviderAccountUsageWindowSource::VARIANTS;
    /// The generation a newly registered account starts at.
    pub const CREDENTIAL_GENERATION_MIN: u64 = 1;
    /// The limit id a quota reading takes when it names none.
    pub const PROVIDER_QUOTA_DEFAULT_LIMIT_ID: &str = "default";
    /// Every way a brokered sign-in ends, in declaration order.
    PROVIDER_SIGN_IN_OUTCOMES = ProviderSignInOutcome::VARIANTS;
    /// Every readiness state, in declaration order.
    PROVIDER_READINESS_STATES = readiness::ProviderReadinessState::VARIANTS;
}

/// How an account is charged. `unknown` means not known, never `metered`: it labels cost and
/// never derives it.
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
pub enum BillingMode {
    /// A subscription.
    Subscription,
    /// Charged per use.
    Metered,
    /// Not known.
    Unknown,
}

/// The stored outcome of an account's last validation. `indeterminate` means the probe could not
/// decide or none has run; it counts as not authenticated, and a stored null is sent as it.
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
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum ProviderAccountHealthState {
    /// Signed in.
    Authenticated,
    /// The sign-in is gone.
    ReauthRequired,
    /// The credential home is missing.
    HomeMissing,
    /// Not decided.
    Indeterminate,
}

/// The authentication mode the provider's own status output reports for a home; never assumed or
/// read from a credential file's shape. `unknown` is a mode this build does not recognize.
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
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum ProviderAuthMode {
    /// A subscription sign-in.
    OauthSubscription,
    /// A pasted sign-in token.
    OauthToken,
    /// A pasted API key.
    ApiKey,
    /// Credentials the provider takes from elsewhere.
    External,
    /// Signed out.
    None,
    /// A mode this build does not recognize.
    Unknown,
}

/// Maps the mode a provider's own status output reports onto [`ProviderAuthMode`]; never fails,
/// so a new provider mode costs precision, not the reading. `None` when nothing or only blank text
/// was reported, which differs from `unknown`, a mode reported but not recognized. The provider's
/// words are its own (`authMethod: oauth_token`), matched exactly and never through the wire form.
pub fn normalize_observed_provider_auth_mode(reported: Option<&Value>) -> Option<ProviderAuthMode> {
    match reported {
        None | Some(Value::Null) => None,
        Some(Value::String(mode)) => {
            let trimmed = mode.trim_matches(is_ecmascript_whitespace);
            (!trimmed.is_empty()).then_some(match trimmed {
                "oauth_subscription" => ProviderAuthMode::OauthSubscription,
                "oauth_token" => ProviderAuthMode::OauthToken,
                "api_key" => ProviderAuthMode::ApiKey,
                "external" => ProviderAuthMode::External,
                "none" => ProviderAuthMode::None,
                _ => ProviderAuthMode::Unknown,
            })
        }
        Some(_) => Some(ProviderAuthMode::Unknown),
    }
}

/// Which kind of reading produced a quota window: `probe` is the account's own limits read and
/// replaces the stored set; `run` is the provider's push during a turn and is merged in.
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
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum ProviderAccountUsageWindowSource {
    /// The account's own limits read.
    Probe,
    /// The provider's push during a turn.
    Run,
}

branded_text! {
    /// The daemon-minted opaque id of one account, not a UUID and never derived from a
    /// credential, an email or a path, since those rotate and the id keys historical spend.
    pub struct ProviderAccountId(1..=PROVIDER_ACCOUNT_ID_MAX_LEN);
}

/// A counter that starts at [`CREDENTIAL_GENERATION_MIN`] and rises at each credential-home
/// transition; it never decreases or resets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CredentialGeneration(SafeInt<CREDENTIAL_GENERATION_MIN>);

impl JsonSchema for CredentialGeneration {
    fn schema_name() -> Cow<'static, str> {
        "CredentialGeneration".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = SafeInt::<CREDENTIAL_GENERATION_MIN>::json_schema(generator);
        schema.insert(
            "description".into(),
            "A counter that starts at 1 and rises at each credential-home transition; it never \
             decreases or resets."
                .into(),
        );
        schema
    }
}

/// The name the person gives an account added from a pasted token or API key: free-form text,
/// trimmed after its checks, so a stored name never differs from another by its surrounding
/// spaces.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct DisplayLabel(String);

impl DisplayLabel {
    /// The trimmed name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for DisplayLabel {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let checked =
            FreeFormText::<PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN>::deserialize(deserializer)?;
        Ok(Self(
            checked
                .as_str()
                .trim_matches(is_ecmascript_whitespace)
                .to_owned(),
        ))
    }
}

impl JsonSchema for DisplayLabel {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "DisplayLabel".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        FreeFormText::<PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN>::json_schema(generator)
    }
}

/// The kind of a memory import that copied something.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
#[strum(serialize_all = "camelCase")]
pub enum MemoryImportOutcomeKind {
    /// Copied.
    Imported,
}

/// How the account's one memory import went: `imported` counts what was copied and when,
/// `nothingToImport` found nothing. The outcome is kept, so a repeat answers it again.
#[derive(
    Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate, VariantNames,
)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[strum(serialize_all = "camelCase")]
#[garde(allow_unvalidated)]
pub enum ProviderAccountMemoryImportOutcome {
    /// Something was copied.
    Imported {
        /// How much.
        count: SafeInt<1>,
        /// When.
        #[garde(dive)]
        imported_at: WireInstant,
    },
    /// Nothing was found to copy.
    NothingToImport {},
}

/// The health states that are the outcome of an observation, and so carry its time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ObservedHealthState {
    /// Signed in.
    Authenticated,
    /// The sign-in is gone.
    ReauthRequired,
    /// The credential home is missing.
    HomeMissing,
}

/// The health state that may lack an observation time: never probed, or probed and undecided.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum UndecidedHealthState {
    /// Not decided.
    Indeterminate,
}

/// Declares one arm of [`ProviderAccount`]: the members every account carries, then the arm's
/// health state and its observation time.
macro_rules! provider_account_arm {
    ($(#[doc = $doc:literal])+ $name:ident { $($health:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The account's id.
            pub account_id: ProviderAccountId,
            /// The provider.
            pub provider: ProviderId,
            /// The name the person gave an account added from a pasted token or API key; absent
            /// on every other account, which its provider-reported identity names.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN>")]
            pub display_label: Option<FreeFormText<PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN>>,
            /// The credential home's generation.
            pub credential_generation: CredentialGeneration,
            /// How the account is charged.
            pub billing_mode: BillingMode,
            /// The email the provider reported.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<PROVIDER_ACCOUNT_EMAIL_MAX_LEN>")]
            pub observed_account_email: Option<FreeFormText<PROVIDER_ACCOUNT_EMAIL_MAX_LEN>>,
            /// The organization id the provider reported.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<PROVIDER_ACCOUNT_ORG_ID_MAX_LEN>")]
            pub observed_account_org_id: Option<FreeFormText<PROVIDER_ACCOUNT_ORG_ID_MAX_LEN>>,
            /// The organization name the provider reported.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN>")]
            pub observed_account_org_name: Option<FreeFormText<PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN>>,
            /// The plan id exactly as the provider sends it.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<PROVIDER_ACCOUNT_PLAN_MAX_LEN>")]
            pub observed_account_plan: Option<FreeFormText<PROVIDER_ACCOUNT_PLAN_MAX_LEN>>,
            /// Whether this is the provider's default account; at most one is.
            pub is_default: bool,
            /// The places where the account has a home; absent on a computer without a WSL 2
            /// distribution.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "UniqueList<Place, 1, { usize::MAX }>")]
            #[garde(dive)]
            pub home_places: Option<UniqueList<Place, 1, { usize::MAX }>>,
            $($health)*
            /// The mode an observation named, or `null` until one has.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<ProviderAuthMode>")]
            pub observed_auth_mode: Option<ProviderAuthMode>,
            /// When this home's credential was issued, or `null` where nothing produced the time.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<WireInstant>")]
            #[garde(dive)]
            pub signed_in_at: Option<WireInstant>,
            /// When the credential was last seen refreshed, or `null` for none seen.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<WireInstant>")]
            #[garde(dive)]
            pub last_refresh_observed_at: Option<WireInstant>,
            /// An estimate of when sign-in will be needed again, shown as approximate; `null`
            /// when the issue time or the mode is.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<WireInstant>")]
            #[garde(dive)]
            pub sign_in_needed_at_estimate: Option<WireInstant>,
            /// `false` when the person silenced the background observer for this account.
            pub probe_enabled: bool,
            /// Start each usage window as soon as it opens; it does nothing while the observer is
            /// off.
            pub window_start_enabled: bool,
            /// Wake this computer for a window that resets while it sleeps.
            pub wake_for_window_start_enabled: bool,
            /// The account's one memory import, or `null` until it has run.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<ProviderAccountMemoryImportOutcome>")]
            #[garde(dive)]
            pub memory_import: Option<ProviderAccountMemoryImportOutcome>,
        }
    };
}

provider_account_arm! {
    /// An account whose health state is the outcome of an observation, with its time.
    ObservedProviderAccount {
        /// The stored health state.
        pub health_state: ObservedHealthState,
        /// When the state was observed.
        #[garde(dive)]
        pub health_observed_at: WireInstant,
    }
}

provider_account_arm! {
    /// An account whose health is undecided: never observed (`null`), or observed and undecided.
    UndecidedProviderAccount {
        /// Always `indeterminate`.
        pub health_state: UndecidedHealthState,
        /// When the state was observed, or `null` for never.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<WireInstant>")]
        #[garde(dive)]
        pub health_observed_at: Option<WireInstant>,
    }
}

/// One registered provider account as sent on the wire. Only an `indeterminate` account may lack
/// the time its health state was observed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum ProviderAccount {
    /// Its health state is an observation's outcome.
    Observed(#[garde(dive)] ObservedProviderAccount),
    /// Its health is undecided.
    Undecided(#[garde(dive)] UndecidedProviderAccount),
}

/// The members of an account its label is drawn from: an account's own, or the columns a
/// workflow step's spent account keeps.
pub struct AccountLabelFields<'account> {
    /// The label the person gave, if any.
    pub display_label: Option<&'account str>,
    /// How the provider says the account signed in.
    pub observed_auth_mode: Option<ProviderAuthMode>,
    /// The email the provider reports.
    pub observed_account_email: Option<&'account str>,
    /// The plan the provider reports.
    pub observed_account_plan: Option<&'account str>,
    /// The organization the provider reports.
    pub observed_account_org_name: Option<&'account str>,
}

/// Reads the members both arms of [`ProviderAccount`] carry.
macro_rules! either_arm {
    ($account:expr, |$arm:ident| $body:expr) => {
        match $account {
            ProviderAccount::Observed($arm) => $body,
            ProviderAccount::Undecided($arm) => $body,
        }
    };
}

impl ProviderAccount {
    /// Whether this is the provider's default account.
    pub fn is_default(&self) -> bool {
        either_arm!(self, |account| account.is_default)
    }

    /// The members the account's label is drawn from.
    pub fn label_fields(&self) -> AccountLabelFields<'_> {
        either_arm!(self, |account| AccountLabelFields {
            display_label: account.display_label.as_ref().map(FreeFormText::as_str),
            observed_auth_mode: account.observed_auth_mode,
            observed_account_email: account
                .observed_account_email
                .as_ref()
                .map(FreeFormText::as_str),
            observed_account_plan: account
                .observed_account_plan
                .as_ref()
                .map(FreeFormText::as_str),
            observed_account_org_name: account
                .observed_account_org_name
                .as_ref()
                .map(FreeFormText::as_str),
        })
    }
}

/// One quota reading for one window of one limit of one account, keyed by all three: a provider
/// can publish several limits that share a window length, and one limit with two windows at once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountUsageWindow {
    /// The account, since the list reply is one flat array over all accounts.
    pub account_id: ProviderAccountId,
    /// The provider's own limit id, as sent; a reading that names none takes
    /// [`PROVIDER_QUOTA_DEFAULT_LIMIT_ID`].
    pub limit_id: FreeFormText<PROVIDER_QUOTA_LIMIT_ID_MAX_LEN>,
    /// The window's length in minutes.
    pub window_mins: SafeInt<1>,
    /// The provider's own label for the window, never parsed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_QUOTA_LABEL_MAX_LEN>")]
    pub label: Option<FreeFormText<PROVIDER_QUOTA_LABEL_MAX_LEN>>,
    /// Utilization when observed, not clamped to 100, since a provider may report
    /// over-consumption.
    pub used_percent: NonNegativeNumber,
    /// When the window resets, where the provider says.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub resets_at: Option<WireInstant>,
    /// When it was read: the newest per account and limit wins, and `source` breaks ties.
    #[garde(dive)]
    pub observed_at: WireInstant,
    /// The account's credential generation when this was read, so an earlier one reads stale.
    pub observed_credential_generation: CredentialGeneration,
    /// Which kind of reading produced it.
    pub source: ProviderAccountUsageWindowSource,
}

/// The request of `provider.account.list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountListRequest {
    /// The provider to read, or every one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderId")]
    pub provider: Option<ProviderId>,
    /// Scopes readiness to one account instead of the provider's default; an unknown or removed
    /// id is refused, never replaced by the default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderAccountId")]
    pub account_id: Option<ProviderAccountId>,
}

/// The reply of `provider.account.list`: the accounts, the stored quota readings (sent on the read
/// because the subscription is a live tail), and exactly one readiness entry per provider read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountListResponse {
    /// The accounts.
    #[garde(dive)]
    pub accounts: Vec<ProviderAccount>,
    /// The stored quota readings.
    #[garde(dive)]
    pub usage_windows: Vec<ProviderAccountUsageWindow>,
    /// One readiness entry per provider read.
    #[garde(dive)]
    pub readiness: Vec<readiness::ProviderReadiness>,
}

/// How a brokered sign-in attempt ended.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSignInOutcome {
    /// The provider's flow finished; the account's health is observed next.
    Succeeded,
    /// The flow failed.
    Failed,
    /// The flow was canceled.
    Canceled,
}

/// A change to the machine's account registry, which `provider.account.subscribe` sends as a full
/// state update, so seeing one twice is harmless. A usage window's reading belongs to the account
/// the notification routes to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
#[garde(custom(window_names_routed_account))]
pub enum ProviderAccountNotification {
    /// Registered, corrected, default moved, or a stored reading rewritten.
    AccountChanged {
        /// The account as it now is.
        #[garde(dive)]
        account: ProviderAccount,
    },
    /// Removed.
    AccountRemoved {
        /// The account.
        account_id: ProviderAccountId,
    },
    /// A brokered sign-in waits for the code its sign-in page shows, read from the provider's
    /// prompt and never its text; `provider.account.signInCode.submit` answers it.
    SignInCodeRequested {
        /// The attempt.
        attempt_id: FreeFormText<PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN>,
    },
    /// A brokered sign-in ended. `succeeded` means only that the provider's flow finished; the
    /// account's health follows as `accountChanged`.
    SignInCompleted {
        /// The attempt.
        attempt_id: FreeFormText<PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN>,
        /// The account.
        account_id: ProviderAccountId,
        /// How it ended.
        outcome: ProviderSignInOutcome,
        /// Text for the person, with no credential, provider error body or home path.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN>")]
        failure_reason: Option<FreeFormText<PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN>>,
    },
    /// A new quota reading.
    #[schemars(extend("allOf" = [{ "type": "object", "properties": { "window": {
        "type": "object",
        "properties": { "accountId": { "const": { "$data": "2/accountId" } } },
    } } }]))]
    UsageWindowUpdated {
        /// The account the reading is routed to.
        account_id: ProviderAccountId,
        /// The reading; its own `accountId` is the routed one.
        #[garde(dive)]
        window: ProviderAccountUsageWindow,
    },
}

/// Whether a usage window's reading names the account its notification routes to.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn window_names_routed_account(
    notification: &ProviderAccountNotification,
    (): &(),
) -> garde::Result {
    match notification {
        ProviderAccountNotification::UsageWindowUpdated { account_id, window }
            if window.account_id != *account_id =>
        {
            Err(garde::Error::new(
                "window.accountId must equal the notification's accountId",
            ))
        }
        ProviderAccountNotification::UsageWindowUpdated { .. }
        | ProviderAccountNotification::AccountChanged { .. }
        | ProviderAccountNotification::AccountRemoved { .. }
        | ProviderAccountNotification::SignInCodeRequested { .. }
        | ProviderAccountNotification::SignInCompleted { .. } => Ok(()),
    }
}

/// The TypeScript module of the account record.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/account/record",
    doc: "The provider account record and how it is read: the account as sent on the wire, each \
          provider's readiness and its remedy, the per-limit quota reading, \
          `provider.account.list` and the `provider.account.subscribe` live tail.",
    definitions: &[
        Definition::read::<BillingMode>().checked(),
        Definition::read::<ProviderAccountHealthState>().checked(),
        Definition::read::<ProviderAuthMode>().checked(),
        Definition::read::<ProviderAccountUsageWindowSource>().checked(),
        Definition::read::<ProviderAccountId>().checked(),
        Definition::read::<CredentialGeneration>().checked(),
        Definition::read::<ProviderAccountMemoryImportOutcome>().checked(),
        Definition::read::<ProviderAccount>().checked(),
        Definition::read::<readiness::ProviderReadinessState>().checked(),
        Definition::read::<readiness::ProviderRegisterRemedy>(),
        Definition::read::<readiness::ProviderChooseCurrentRemedy>(),
        Definition::read::<readiness::ProviderSignInRemedy>(),
        Definition::read::<readiness::ProviderPasteTokenRemedy>(),
        Definition::read::<readiness::ProviderLookAgainRemedy>(),
        Definition::read::<readiness::ProviderRemedy>().checked(),
        Definition::read::<readiness::ProviderSignInExpiredRemedy>(),
        Definition::read::<readiness::ProviderReadiness>().checked(),
        Definition::read::<ProviderAccountUsageWindow>().checked(),
        Definition::read::<ProviderAccountListRequest>().checked(),
        Definition::read::<ProviderAccountListResponse>().checked(),
        Definition::read::<ProviderSignInOutcome>(),
        Definition::read::<ProviderAccountNotification>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
