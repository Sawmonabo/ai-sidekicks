//! The id of a provider's standing rule, minted one way for every provider.

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::settings::{ProviderStandingRuleId, ProviderStandingRuleScope};

/// The id of the standing rule `text`, which the file `source_path` in `place` holds under `scope`
/// with the provider's `decision` word: a blake3 hex digest of the parts, each length-prefixed so
/// no two different sets of parts give the same bytes. The same text in two places, two files, two
/// scopes or under two decisions names two rules, and a file read again gives the same ids; a rule
/// of the provider's system layer holds under no scope.
pub(crate) fn mint_standing_rule_id(
    place: Option<&Place>,
    source_path: &FilesystemPath,
    scope: Option<&ProviderStandingRuleScope>,
    decision: &str,
    text: &str,
) -> ProviderStandingRuleId {
    let (place_kind, place_name) = match place {
        None => ("", ""),
        Some(Place::Windows(_)) => ("windows", ""),
        Some(Place::Wsl(wsl)) => ("wsl", wsl.distro.as_str()),
    };
    let (scope_kind, scope_id) = match scope {
        None => ("", String::new()),
        Some(ProviderStandingRuleScope::AccountHome { account_id }) => {
            ("accountHome", account_id.as_str().to_owned())
        }
        Some(ProviderStandingRuleScope::Project { repo_mount_id }) => {
            ("project", repo_mount_id.to_string())
        }
    };
    let mut hasher = blake3::Hasher::new();
    for part in [
        place_kind,
        place_name,
        source_path.as_str(),
        scope_kind,
        scope_id.as_str(),
        decision,
        text,
    ] {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    ProviderStandingRuleId::new(hasher.finalize().to_hex().to_string())
        .expect("a 64-digit hex digest lies within the id's bounds")
}
