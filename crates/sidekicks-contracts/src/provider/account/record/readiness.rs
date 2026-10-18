//! Each provider's readiness to start a run and the one remedy shown when it is not ready.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use super::ProviderAccountId;
use crate::provider::id::ProviderId;
use crate::wire::instant::WireInstant;
use crate::wire::list::BoundedVec;
use crate::wire::literal;

/// The pre-computed answer to what run admission will ask. The first four are the resolved
/// account's stored health state; `noAccount` and `noCurrent` stand where resolution reached no
/// account. It authorizes nothing: admission checks again.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum ProviderReadinessState {
    /// Signed in.
    Authenticated,
    /// The sign-in is gone.
    ReauthRequired,
    /// The credential home is missing.
    HomeMissing,
    /// Not decided.
    Indeterminate,
    /// No account is registered.
    NoAccount,
    /// No account is the provider's current account.
    NoCurrent,
}

/// Declares the remedies: each one's `kind` word as a literal and its standalone struct, then
/// [`ProviderSignInExpiredRemedy`] from the sign-in-expired group and [`ProviderRemedy`] from both
/// groups, every enum arm repeating its struct's members.
macro_rules! remedies {
    (
        sign_in_expired {$(
            $(#[doc = $expired_doc:literal])+
            $expired_arm:ident($expired_struct:ident, $expired_kind:ident = $expired_word:literal) {
                $($(#[$expired_attribute:meta])* $expired_member:ident: $expired_type:ty,)*
            }
        )+}
        other {$(
            $(#[doc = $other_doc:literal])+
            $other_arm:ident($other_struct:ident, $other_kind:ident = $other_word:literal) {
                $($(#[$other_attribute:meta])* $other_member:ident: $other_type:ty,)*
            }
        )+}
    ) => {
        remedies!(@struct $(
            $(#[doc = $expired_doc])+
            $expired_struct, $expired_kind = $expired_word {
                $($(#[$expired_attribute])* $expired_member: $expired_type,)*
            }
        )+ $(
            $(#[doc = $other_doc])+
            $other_struct, $other_kind = $other_word {
                $($(#[$other_attribute])* $other_member: $other_type,)*
            }
        )+);

        /// The remedy of one account whose sign-in is gone: the provider's own sign-in, or, on a
        /// token or API-key account, a freshly minted token pasted in.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
        pub enum ProviderSignInExpiredRemedy {$(
            $(#[doc = $expired_doc])+
            #[serde(rename = $expired_word)]
            $expired_arm {
                $($(#[$expired_attribute])* $expired_member: $expired_type,)*
            },
        )+}

        /// The next step shown for a readiness state that is not `authenticated`. A client renders
        /// off `kind`, not `state`, since `reauthRequired` takes `signIn` or `pasteToken`.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
        pub enum ProviderRemedy {$(
            $(#[doc = $expired_doc])+
            #[serde(rename = $expired_word)]
            $expired_arm {
                $($(#[$expired_attribute])* $expired_member: $expired_type,)*
            },
        )+ $(
            $(#[doc = $other_doc])+
            #[serde(rename = $other_word)]
            $other_arm {
                $($(#[$other_attribute])* $other_member: $other_type,)*
            },
        )+}
    };
    (@struct $(
        $(#[doc = $doc:literal])+
        $name:ident, $kind:ident = $word:literal {
            $($(#[$attribute:meta])* $member:ident: $type:ty,)*
        }
    )+) => {$(
        literal! {
            /// The one value of the remedy's `kind`.
            pub enum $kind = $word;
        }

        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// What the person does.
            pub kind: $kind,
            $($(#[$attribute])* pub $member: $type,)*
        }
    )+};
}

remedies! {
    sign_in_expired {
        /// Remedy for a resolved account that is not authenticated: run the provider's own
        /// sign-in.
        SignIn(ProviderSignInRemedy, SignInRemedyKind = "signIn") {
            /// The resolved account.
            account_id: ProviderAccountId,
        }
        /// Remedy for `reauthRequired` on a token or API-key account: it cannot refresh itself,
        /// so the person mints a fresh token at the provider and pastes it.
        PasteToken(ProviderPasteTokenRemedy, PasteTokenRemedyKind = "pasteToken") {
            /// The resolved account.
            account_id: ProviderAccountId,
        }
    }
    other {
        /// Remedy for `noAccount`: register an account for the provider.
        Register(ProviderRegisterRemedy, RegisterRemedyKind = "register") {
            /// The provider.
            provider: ProviderId,
        }
        /// Remedy for `noCurrent`: the person picks one of the listed accounts as the provider's
        /// current account.
        ChooseCurrent(ProviderChooseCurrentRemedy, ChooseCurrentRemedyKind = "chooseCurrent") {
            /// The candidates; the daemon lists them and never picks one. One account that is not
            /// current is still listed rather than elected.
            candidate_account_ids: BoundedVec<ProviderAccountId, 1, { usize::MAX }>,
        }
        /// Remedy for `indeterminate`: nothing wrong can be seen, so the next read may settle it
        /// and `provider.account.probe` asks again. Never a sign-in.
        LookAgain(ProviderLookAgainRemedy, LookAgainRemedyKind = "lookAgain") {
            /// The resolved account.
            account_id: ProviderAccountId,
        }
    }
}

impl ProviderSignInExpiredRemedy {
    /// The account the remedy names.
    pub fn account_id(&self) -> &ProviderAccountId {
        match self {
            Self::SignIn { account_id } | Self::PasteToken { account_id } => account_id,
        }
    }
}

/// One provider's readiness to start a run, tagged on `state`, with the remedy the state calls
/// for. A remedy that names an account names the entry's own resolved account, so the person is
/// never pointed at one account to fix another.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
#[garde(custom(remedy_names_resolved_account))]
pub enum ProviderReadiness {
    /// Ready; it carries no remedy.
    Authenticated {
        /// The provider.
        provider: ProviderId,
        /// The account resolution reached, when it reached exactly one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderAccountId")]
        resolved_account_id: Option<ProviderAccountId>,
        /// When the stored observation the state was read from was made.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        observed_at: Option<WireInstant>,
    },
    /// The resolved account's sign-in is gone.
    #[schemars(extend("allOf" = [{ "type": "object", "properties": { "remedy": {
        "type": "object",
        "properties": { "accountId": { "const": { "$data": "2/resolvedAccountId" } } },
    } } }]))]
    ReauthRequired {
        /// The provider.
        provider: ProviderId,
        /// The account resolution reached.
        resolved_account_id: ProviderAccountId,
        /// When the stored observation the state was read from was made.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        observed_at: Option<WireInstant>,
        /// Sign in again, or paste a fresh token; which applies is the producer's call.
        remedy: ProviderSignInExpiredRemedy,
    },
    /// The resolved account's credential home is missing.
    #[schemars(extend("allOf" = [{ "type": "object", "properties": { "remedy": {
        "type": "object",
        "properties": { "accountId": { "const": { "$data": "2/resolvedAccountId" } } },
    } } }]))]
    HomeMissing {
        /// The provider.
        provider: ProviderId,
        /// The account resolution reached.
        resolved_account_id: ProviderAccountId,
        /// When the stored observation the state was read from was made.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        observed_at: Option<WireInstant>,
        /// Sign in again.
        remedy: ProviderSignInRemedy,
    },
    /// The resolved account's health is undecided.
    #[schemars(extend("allOf" = [{ "type": "object", "properties": { "remedy": {
        "type": "object",
        "properties": { "accountId": { "const": { "$data": "2/resolvedAccountId" } } },
    } } }]))]
    Indeterminate {
        /// The provider.
        provider: ProviderId,
        /// The account resolution reached.
        resolved_account_id: ProviderAccountId,
        /// When the stored observation the state was read from was made; absent for none yet.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        observed_at: Option<WireInstant>,
        /// Look again.
        remedy: ProviderLookAgainRemedy,
    },
    /// No account is registered for the provider.
    NoAccount {
        /// The provider.
        provider: ProviderId,
        /// The account resolution reached, when it reached exactly one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderAccountId")]
        resolved_account_id: Option<ProviderAccountId>,
        /// When the stored observation the state was read from was made.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        observed_at: Option<WireInstant>,
        /// Register an account.
        remedy: ProviderRegisterRemedy,
    },
    /// Accounts are registered but none is the provider's current account.
    NoCurrent {
        /// The provider.
        provider: ProviderId,
        /// The account resolution reached, when it reached exactly one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderAccountId")]
        resolved_account_id: Option<ProviderAccountId>,
        /// When the stored observation the state was read from was made.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        observed_at: Option<WireInstant>,
        /// Choose the current account.
        remedy: ProviderChooseCurrentRemedy,
    },
}

/// Whether a remedy that names an account names the entry's resolved account.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn remedy_names_resolved_account(readiness: &ProviderReadiness, (): &()) -> garde::Result {
    let (resolved, named) = match readiness {
        ProviderReadiness::ReauthRequired {
            resolved_account_id,
            remedy,
            ..
        } => (resolved_account_id, remedy.account_id()),
        ProviderReadiness::HomeMissing {
            resolved_account_id,
            remedy,
            ..
        } => (resolved_account_id, &remedy.account_id),
        ProviderReadiness::Indeterminate {
            resolved_account_id,
            remedy,
            ..
        } => (resolved_account_id, &remedy.account_id),
        ProviderReadiness::Authenticated { .. }
        | ProviderReadiness::NoAccount { .. }
        | ProviderReadiness::NoCurrent { .. } => return Ok(()),
    };
    if resolved == named {
        Ok(())
    } else {
        Err(garde::Error::new(
            "remedy.accountId must equal resolvedAccountId",
        ))
    }
}
