//! The sign-in side of `provider.account.*`: registering an account, which carries the one request
//! member that may hold a credential; rebuilding an account's credential home; and the brokered
//! interactive sign-in with its code and its cancel. The members a request-logging transport must
//! redact sit here beside the inputs they concern.

use std::borrow::Cow;
use std::fmt;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use secrecy::zeroize::Zeroize as _;
use secrecy::{ExposeSecret as _, SecretString};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use strum::VariantArray;
use subtle::ConstantTimeEq as _;

use crate::jsonrpc::refusal::RefusalCode;
use crate::keychain::KeychainRefusalCause;
use crate::provider::account::record::{
    BillingMode, CredentialGeneration, DisplayLabel, PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN,
    ProviderAccount, ProviderAccountHealthState, ProviderAccountId,
};
use crate::provider::id::ProviderId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::web_address::HttpsAddress;
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest provider verification address, carried verbatim.
    pub const PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN: usize = 2048;
    /// The longest device code the person types at the verification address.
    pub const PROVIDER_SIGN_IN_USER_CODE_MAX_LEN: usize = 64;
    /// The longest code a sign-in page shows for the person to paste back.
    pub const PROVIDER_SIGN_IN_CODE_MAX_LEN: usize = 1024;
    /// The longest pasted token: generous, since the vendor mints it, and bounded so no unbounded
    /// body rides in through the one member whose value is never logged.
    pub const PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN: usize = 8192;
    /// A pasted token could not be sealed in this machine's keychain, so nothing was stored.
    PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE =
        RefusalCode::ProviderAccountCredentialSealRefused;
    /// The provider's status output, run on a pasted token, reported no signed-in mode, so
    /// nothing is registered, sealed or replaced.
    PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE = RefusalCode::ProviderAccountTokenNotAccepted;
    /// The name given to a token or API-key account repeats another of that provider's account
    /// names; a rename refuses on the same code.
    PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE = RefusalCode::ProviderAccountDisplayLabelTaken;
    /// Every way a cancel ends, in declaration order.
    PROVIDER_SIGN_IN_CANCEL_STATUSES = ProviderSignInCancelStatus::VARIANTS;
    /// Every way a code submit ends, in declaration order.
    PROVIDER_SIGN_IN_CODE_SUBMIT_STATUSES = ProviderSignInCodeSubmitStatus::VARIANTS;
    /// Wire members a request-logging transport redacts before writing a record, listed once so
    /// no transport derives the list again: the pasted token and the sign-in page's code.
    pub const PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS: [&str; 2] = ["nonInteractiveToken", "code"];
}

/// The text rules a pasted token is held to: not blank, no NUL, within its cap.
type NonInteractiveTokenText = FreeFormText<PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN>;

/// What a pasted token's `Debug` prints in place of its text.
const NON_INTERACTIVE_TOKEN_MARKER: &str = "[REDACTED]";

/// A pasted token or API key: the one credential-accepting input on this wire, write-only. It is
/// on no reply and never logged, shown, echoed or put in an argument vector; it is sealed in the
/// keychain, never written into the credential home. Its text is held as a secret: `Debug` prints
/// only a marker, it has no `Display`, two tokens compare in constant time, and the register
/// request's own member serializer is the one path that writes it.
#[derive(Clone)]
pub struct NonInteractiveToken(SecretString);

impl NonInteractiveToken {
    /// The token, still a secret, for the daemon to seal or hand to its provider.
    pub fn into_secret(self) -> SecretString {
        self.0
    }
}

impl fmt::Debug for NonInteractiveToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(NON_INTERACTIVE_TOKEN_MARKER)
    }
}

impl PartialEq for NonInteractiveToken {
    fn eq(&self, other: &Self) -> bool {
        let this = self.0.expose_secret().as_bytes();
        this.ct_eq(other.0.expose_secret().as_bytes()).into()
    }
}

impl Eq for NonInteractiveToken {}

impl<'de> Deserialize<'de> for NonInteractiveToken {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_str(NonInteractiveTokenVisitor)
    }
}

/// Reads a pasted token, holding its text to the rules before the secret is built. A refusal
/// names the rule it broke, never the text.
struct NonInteractiveTokenVisitor;

impl Visitor<'_> for NonInteractiveTokenVisitor {
    type Value = NonInteractiveToken;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a pasted token")
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Self::Value, E> {
        NonInteractiveTokenText::check(text).map_err(E::custom)?;
        // Built from the borrowed text, so the secret's buffer is the only copy this read makes.
        Ok(NonInteractiveToken(SecretString::from(text)))
    }

    fn visit_string<E: de::Error>(self, mut text: String) -> Result<Self::Value, E> {
        // Copied into the secret, then wiped: `SecretString::from(String)` may reallocate and
        // leave the first buffer behind unwiped.
        let token = self.visit_str(&text);
        text.zeroize();
        token
    }
}

impl JsonSchema for NonInteractiveToken {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        NonInteractiveTokenText::schema_name()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        NonInteractiveTokenText::json_schema(generator)
    }
}

/// Writes a pasted token's text: the register request's own member serializer, so a client can
/// send the request and nothing else can write the token.
fn expose_for_send<S: Serializer>(
    token: &NonInteractiveToken,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(token.0.expose_secret())
}

/// Registers an account the provider's own sign-in will name; it carries no name or token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SignInRegistration {
    /// The provider.
    pub provider: ProviderId,
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
    pub provider: ProviderId,
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
    #[serde(serialize_with = "expose_for_send")]
    pub non_interactive_token: NonInteractiveToken,
}

/// Replaces the sealed token of a registered account, the remedy for a token account's lost
/// sign-in, which keeps its spend, quota and attention history; an id that names no account is
/// refused, never created.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct TokenResupply {
    /// The provider, which must match the stored account's.
    pub provider: ProviderId,
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
    #[serde(serialize_with = "expose_for_send")]
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
pub struct ProviderAccountCredentialHomeResetRequest {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// The account's new credential generation and health after the rebuild.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountCredentialHomeResetResponse {
    /// The account.
    pub account_id: ProviderAccountId,
    /// The generation after the rebuild, greater than the one before.
    pub credential_generation: CredentialGeneration,
    /// `reauthRequired` until the person signs in.
    pub health_state: ProviderAccountHealthState,
}

/// Signs in an account already registered, into its own home.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct RegisteredAccountSignIn {
    /// The account.
    pub account_id: ProviderAccountId,
}

/// Adds an account through its provider's sign-in: the daemon mints the id and the home, and
/// inserts the row only once the provider names who signed in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct NewAccountSignIn {
    /// The provider.
    pub provider: ProviderId,
}

/// Starts the provider's own interactive sign-in, for a registered account or a new one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum ProviderAccountSignInRequest {
    /// A registered account.
    Registered(RegisteredAccountSignIn),
    /// A new account.
    New(NewAccountSignIn),
}

/// What the person needs to finish the sign-in, and the key to cancel it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountSignInResponse {
    /// Opaque, daemon-minted and single-use: the key for cancel and for completion.
    pub attempt_id: FreeFormText<PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN>,
    /// Where the person finishes the flow: the provider's own `https:` address, verbatim, since
    /// the person opens it.
    pub verification_uri: HttpsAddress<PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN>,
    /// The device code the person types at the address, on a device-code flow.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_SIGN_IN_USER_CODE_MAX_LEN>")]
    pub user_code: Option<FreeFormText<PROVIDER_SIGN_IN_USER_CODE_MAX_LEN>>,
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

/// Cancels one sign-in attempt by the id its `provider.account.signIn` reply returned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountSignInAttemptCancelRequest {
    /// The attempt.
    pub attempt_id: FreeFormText<PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN>,
}

/// How a cancel ended. `notFound` covers an attempt that already ended or never existed; it is
/// no error, so a client racing a completion sees no refusal for losing.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSignInCancelStatus {
    /// The provider's sign-in was ended.
    Canceled,
    /// No such attempt was open.
    NotFound,
}

/// How the cancel ended.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountSignInAttemptCancelResponse {
    /// The outcome.
    pub status: ProviderSignInCancelStatus,
}

/// Sends the code a Claude Code sign-in page shows to the sign-in waiting for it, after
/// `signInCodeRequested`. The code goes to that sign-in's input and nowhere else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountSignInCodeSubmitRequest {
    /// The attempt.
    pub attempt_id: FreeFormText<PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN>,
    /// The code, as the person pasted it.
    pub code: FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
}

/// How a code submit ended. `notFound` covers an attempt that is not waiting for a code; it is
/// no error, as a cancel's is not.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSignInCodeSubmitStatus {
    /// The code was written to the sign-in's input.
    Submitted,
    /// No attempt was waiting for a code.
    NotFound,
}

/// How the code submit ended.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAccountSignInCodeSubmitResponse {
    /// The outcome.
    pub status: ProviderSignInCodeSubmitStatus,
}

/// The TypeScript module of the account sign-in.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/account/sign-in",
    doc: "The sign-in side of `provider.account.*`: registering an account, rebuilding an \
          account's credential home, and the brokered interactive sign-in with its code and its \
          cancel.",
    definitions: &[
        Definition::read::<ProviderAccountRegisterRequest>().checked(),
        Definition::read::<ProviderAccountRegisterResponse>().checked(),
        Definition::read::<ProviderAccountCredentialSealRefusedDetails>().checked(),
        Definition::read::<ProviderAccountCredentialHomeResetRequest>().checked(),
        Definition::read::<ProviderAccountCredentialHomeResetResponse>().checked(),
        Definition::read::<ProviderAccountSignInRequest>().checked(),
        Definition::read::<ProviderAccountSignInResponse>().checked(),
        Definition::read::<ProviderAccountSignInAttemptCancelRequest>().checked(),
        Definition::read::<ProviderSignInCancelStatus>(),
        Definition::read::<ProviderAccountSignInAttemptCancelResponse>().checked(),
        Definition::read::<ProviderAccountSignInCodeSubmitRequest>().checked(),
        Definition::read::<ProviderSignInCodeSubmitStatus>(),
        Definition::read::<ProviderAccountSignInCodeSubmitResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use std::error::Error;

    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{
        NON_INTERACTIVE_TOKEN_MARKER, PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS,
        PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN, ProviderAccountRegisterRequest, TokenRegistration,
    };
    use crate::jsonrpc::issue::reader_issue_path;
    use crate::schema::closed_schema_for;
    use crate::wire::attachment::{ReceivedError, parse_received};

    /// The token every leak case carries.
    const TOKEN: &str = "sk-ant-oat01-do-not-print-7f3a";

    /// A new token account's register body holding `token`.
    fn token_registration(token: &str) -> Value {
        json!({
            "provider": "claude",
            "displayLabel": "Work",
            "billingMode": "subscription",
            "nonInteractiveToken": token,
        })
    }

    /// Every text an error prints: its `Debug` and the `Display` of each link of its chain.
    fn printed_chain(error: &dyn Error) -> String {
        let mut printed = format!("{error:?}");
        let mut link = Some(error);
        while let Some(current) = link {
            printed.push('\n');
            printed.push_str(&current.to_string());
            link = current.source();
        }
        printed
    }

    /// `value` with every member a request-logging transport redacts removed, at any depth.
    fn redacted_for_log(mut value: Value) -> Value {
        if let Value::Object(members) = &mut value {
            for member in PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS {
                members.remove(member);
            }
            for nested in members.values_mut() {
                *nested = redacted_for_log(nested.take());
            }
        }
        value
    }

    #[test]
    fn non_interactive_token_prints_only_its_marker() {
        let request = parse_received::<ProviderAccountRegisterRequest>(
            token_registration(TOKEN).to_string().as_bytes(),
            Vec::new(),
        )
        .expect("a token registration reads");
        let ProviderAccountRegisterRequest::Token(registration) = &request else {
            panic!("a named token body reads as a token registration: {request:?}");
        };
        assert_eq!(
            format!("{:?}", registration.non_interactive_token),
            NON_INTERACTIVE_TOKEN_MARKER
        );
        for printed in [format!("{request:?}"), format!("{request:#?}")] {
            assert!(!printed.contains(TOKEN), "{printed}");
            assert!(printed.contains(NON_INTERACTIVE_TOKEN_MARKER), "{printed}");
        }

        // The send writes the token; the record a request log keeps does not.
        let written = serde_json::to_value(&request).expect("the request writes");
        assert_eq!(written["nonInteractiveToken"], TOKEN);
        let logged = redacted_for_log(written).to_string();
        assert!(!logged.contains(TOKEN), "{logged}");

        // A token serde refuses past the schema: the refusal names the rule, never the text.
        let over_cap = format!(
            "{TOKEN}{}",
            "x".repeat(PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN)
        );
        let read =
            serde_path_to_error::deserialize::<_, TokenRegistration>(token_registration(&over_cap))
                .expect_err("an over-cap token is refused");
        let refusal = ReceivedError::Read {
            path: reader_issue_path(read.path()),
            source: read.into_inner(),
        };
        let printed = printed_chain(&refusal);
        assert!(printed.contains("longer than"), "{printed}");
        assert!(!printed.contains(TOKEN), "{printed}");
    }

    #[rstest]
    #[case::home_on_a_sign_in(json!({
        "provider": "claude",
        "billingMode": "subscription",
        "credentialHomePath": "/tmp/home",
    }))]
    #[case::home_on_a_token(json!({
        "provider": "claude",
        "displayLabel": "Work",
        "billingMode": "subscription",
        "nonInteractiveToken": TOKEN,
        "homePlaces": ["local"],
    }))]
    #[case::home_on_a_resupply(json!({
        "provider": "claude",
        "billingMode": "subscription",
        "accountId": "account-1",
        "nonInteractiveToken": TOKEN,
        "credentialHomePath": "/tmp/home",
    }))]
    #[case::account_id_on_a_sign_in(json!({
        "provider": "claude",
        "billingMode": "subscription",
        "accountId": "account-1",
    }))]
    fn sign_in_register_request_refuses_a_home_or_a_caller_account_id(#[case] body: Value) {
        assert!(serde_json::from_value::<ProviderAccountRegisterRequest>(body.clone()).is_err());
        let schema = closed_schema_for::<ProviderAccountRegisterRequest>().expect("the schema");
        let check = jsonschema::validator_for(&schema).expect("the schema builds a check");
        assert!(!check.is_valid(&body));
        // The received check holds only the shape, so an `accountId` on a sign-in passes it and
        // serde refuses it after; the request is refused either way.
        let refusal = parse_received::<ProviderAccountRegisterRequest>(
            body.to_string().as_bytes(),
            Vec::new(),
        );
        assert!(refusal.is_err(), "{refusal:?}");
    }
}
