//! The provider's own rules on this machine: the paths it refuses an agent, and the standing rules
//! read from and revoked in its own files.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::place::Place;
use crate::provider::account::record::ProviderAccountId;
use crate::provider::id::ProviderId;
use crate::provider::settings::{
    PROVIDER_RULE_DECISION_MAX_LEN, PROVIDER_RULE_TEXT_MAX_LEN, PROVIDER_STANDING_RULE_ID_MAX_LEN,
};
use crate::repo::mount::RepoMountId;
use crate::wire::text::{FreeFormText, branded_text};

/// A protected-path pattern or a standing rule's text.
type RuleText = FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>;

/// One path an agent is refused on this provider, and where it came from: the credential files
/// the app always protects, or a deny rule the person set in the provider's own configuration.
/// Read-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "source",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderProtectedPath {
    /// A credential file the app always protects.
    BuiltIn {
        /// The path pattern.
        pattern: RuleText,
    },
    /// A deny rule in the provider's global configuration.
    Global {
        /// The path pattern.
        pattern: RuleText,
        /// Where the rule's file is, the file's path in that place's form; absent on a computer
        /// without a WSL 2 distribution.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Place")]
        place: Option<Place>,
        /// The file the rule sits in.
        source_path: FilesystemPath,
    },
    /// A deny rule in a project's configuration.
    Project {
        /// The path pattern.
        pattern: RuleText,
        /// The file the rule sits in.
        source_path: FilesystemPath,
        /// The project.
        repo_mount_id: RepoMountId,
    },
}

/// The paths one provider refuses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderProtectedPathListResponse {
    /// The provider.
    pub provider: ProviderId,
    /// Its protected paths.
    pub entries: Vec<ProviderProtectedPath>,
}

branded_text! {
    /// The daemon-minted id of one standing rule, a digest of the rule's place, its file, its
    /// scope, the provider's decision word and its text, so the same text in two places, files,
    /// scopes or decisions names two rules and a file read again gives the same ids.
    pub struct ProviderStandingRuleId(1..=PROVIDER_STANDING_RULE_ID_MAX_LEN);
}

/// Where a standing rule holds: one account's home, or one attached project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderStandingRuleScope {
    /// One account's home.
    AccountHome {
        /// The account.
        account_id: ProviderAccountId,
    },
    /// One attached project.
    Project {
        /// The project.
        repo_mount_id: RepoMountId,
    },
}

/// One standing rule in the provider's own words: `decision` is the provider's word for what the
/// rule does, and `text` the rule as its file holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderStandingRule {
    /// The rule's id.
    pub rule_id: ProviderStandingRuleId,
    /// Where the rule holds; absent for a rule of the provider's own system settings, which holds
    /// for every account and project on the machine and which the daemon never revokes.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderStandingRuleScope")]
    pub scope: Option<ProviderStandingRuleScope>,
    /// Where the rule's file is, the file's path in that place's form; absent on a computer
    /// without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// The file the rule sits in.
    pub source_path: FilesystemPath,
    /// The provider's word for what the rule does.
    pub decision: FreeFormText<PROVIDER_RULE_DECISION_MAX_LEN>,
    /// The rule as its file holds it.
    pub text: RuleText,
}

/// One provider's standing rules on this machine, from every account home in every place and
/// every attached project; an empty list means it holds none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderStandingRuleListResponse {
    /// The provider.
    pub provider: ProviderId,
    /// Its rules.
    pub rules: Vec<ProviderStandingRule>,
}

/// Remove one standing rule where the provider keeps it; it applies from the next tool call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderStandingRuleRevokeRequest {
    /// The provider.
    pub provider: ProviderId,
    /// The rule.
    pub rule_id: ProviderStandingRuleId,
}

/// How a revoke settled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderStandingRuleRevokeOutcome {
    /// The rule was removed from its file.
    Revoked,
    /// The file no longer held it, so revoking twice settles the same way.
    AlreadyAbsent,
}

/// The reply of a revoke.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderStandingRuleRevokeResponse {
    /// The rule.
    pub rule_id: ProviderStandingRuleId,
    /// How the revoke settled.
    pub outcome: ProviderStandingRuleRevokeOutcome,
}
